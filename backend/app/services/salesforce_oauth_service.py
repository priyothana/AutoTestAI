"""
Salesforce OAuth Service
Handles the OAuth 2.0 Authorization Code Flow with per-project credential support.

Credential Resolution:
  From project_integrations DB record (per-project only — no env fallback).
"""
import httpx
import secrets
import hashlib
import base64
from typing import Optional
from uuid import UUID
from datetime import datetime, timedelta
from urllib.parse import quote

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.services.integration_service import IntegrationService, _decrypt


class SalesforceOAuthService:

    @staticmethod
    async def get_auth_url(
        db: AsyncSession,
        project_id: UUID,
    ) -> str:
        """
        Build the Salesforce OAuth authorization URL using per-project
        credentials from the DB.
        """
        integration = await IntegrationService.get_integration(db, project_id)

        # Per-project credentials only — no env fallback
        if not integration or integration.category != "salesforce" or not integration.client_id:
            raise ValueError(
                "No Salesforce credentials found for this project. "
                "Please save your Connected App Client ID and Secret first."
            )

        cid = integration.client_id
        redirect_uri = integration.salesforce_redirect_uri or settings.SALESFORCE_REDIRECT_URI
        login_url = integration.salesforce_login_url or "https://login.salesforce.com"

        # Generate PKCE code_verifier and code_challenge
        code_verifier = secrets.token_urlsafe(64)[:128]
        challenge_digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
        code_challenge = base64.urlsafe_b64encode(challenge_digest).rstrip(b"=").decode("ascii")

        # Store the code_verifier in auth_config so handle_callback can use it
        integration.auth_config = {**(integration.auth_config or {}), "pkce_verifier": code_verifier}
        await db.commit()

        auth_endpoint = f"{login_url}/services/oauth2/authorize"
        return (
            f"{auth_endpoint}"
            f"?response_type=code"
            f"&client_id={quote(cid, safe='')}"
            f"&redirect_uri={quote(redirect_uri, safe='')}"
            f"&state={project_id}"
            f"&scope=api+refresh_token+full"
            f"&code_challenge={code_challenge}"
            f"&code_challenge_method=S256"
        )

    @staticmethod
    async def handle_callback(
        db: AsyncSession,
        code: str,
        state: str,  # project_id
    ) -> dict:
        """
        Exchange the authorization code for access/refresh tokens.
        Uses per-project credentials from DB only.
        """
        project_id = UUID(state)
        integration = await IntegrationService.get_integration(db, project_id)

        # Per-project credentials only — no env fallback
        if not integration or integration.category != "salesforce" or not integration.client_id:
            raise ValueError(
                "No Salesforce credentials found for this project. "
                "Please save your Connected App Client ID and Secret first."
            )

        cid = integration.client_id
        csecret = _decrypt(integration.client_secret)
        redirect_uri = integration.salesforce_redirect_uri or settings.SALESFORCE_REDIRECT_URI
        login_url = integration.salesforce_login_url or "https://login.salesforce.com"

        if not csecret:
            raise ValueError(
                "Salesforce client_secret is missing for this project. "
                "Please re-save your Connected App credentials."
            )

        token_url = f"{login_url}/services/oauth2/token"

        # Retrieve PKCE code_verifier stored during get_auth_url
        code_verifier = (integration.auth_config or {}).get("pkce_verifier")

        token_data = {
            "grant_type": "authorization_code",
            "code": code,
            "client_id": cid,
            "client_secret": csecret,
            "redirect_uri": redirect_uri,
        }
        if code_verifier:
            token_data["code_verifier"] = code_verifier

        async with httpx.AsyncClient() as client:
            response = await client.post(token_url, data=token_data)

        if response.status_code != 200:
            raise Exception(
                f"Salesforce token exchange failed: {response.status_code} {response.text}"
            )

        data = response.json()

        # Extract org_id from the id field (format: https://login.salesforce.com/id/00Dxx.../005xx...)
        org_id = None
        if "id" in data:
            parts = data["id"].rstrip("/").split("/")
            if len(parts) >= 2:
                org_id = parts[-2]

        # Store/update integration with tokens
        result_integration = await IntegrationService.create_sf_integration(
            db=db,
            project_id=project_id,
            instance_url=data["instance_url"],
            access_token=data["access_token"],
            refresh_token=data.get("refresh_token"),
            token_expiry=datetime.utcnow() + timedelta(hours=2),
            org_id=org_id,
        )

        return {
            "status": "connected",
            "project_id": str(project_id),
            "instance_url": data["instance_url"],
            "org_id": org_id,
            "integration_id": str(result_integration.id),
        }

    @staticmethod
    async def refresh_access_token(
        db: AsyncSession,
        project_id: UUID,
    ) -> str:
        """Refresh an expired Salesforce access token using per-project credentials."""
        integration = await IntegrationService.get_integration(db, project_id)
        if not integration or integration.category != "salesforce":
            raise ValueError("No Salesforce integration found for this project")

        tokens = await IntegrationService.get_decrypted_tokens(integration)
        refresh_tok = tokens.get("refresh_token")
        csecret = tokens.get("client_secret")
        cid = integration.client_id
        login_url = integration.salesforce_login_url or "https://login.salesforce.com"

        if not cid:
            raise ValueError("No Salesforce client_id found — re-save Connected App credentials.")
        if not refresh_tok:
            raise ValueError("No refresh token available — re-authorize needed")

        token_url = f"{login_url}/services/oauth2/token"

        async with httpx.AsyncClient() as client:
            response = await client.post(
                token_url,
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_tok,
                    "client_id": cid,
                    "client_secret": csecret or "",
                },
            )

        if response.status_code != 200:
            await IntegrationService.update_sync_status(
                db, integration, "error", f"Token refresh failed: {response.text}"
            )
            raise Exception(f"Token refresh failed: {response.text}")

        data = response.json()

        # Update stored token
        from app.services.integration_service import _encrypt
        integration.access_token = _encrypt(data["access_token"])
        integration.token_expiry = datetime.utcnow() + timedelta(hours=2)
        integration.status = "connected"
        await db.commit()
        await db.refresh(integration)

        return data["access_token"]
