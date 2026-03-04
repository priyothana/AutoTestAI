"""
Project Integration API Endpoints

Handles project connection (Web App / Salesforce / API), OAuth flow,
per-project credential management, metadata sync, and integration status.
"""
import logging

logger = logging.getLogger(__name__)
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID
from typing import Dict, Any

from app.db.session import get_db
from app.schemas.integration import (
    WebAppConnectRequest,
    SalesforceConnectRequest,
    SalesforceCredentialsRequest,
    ApiKeyConnectRequest,
    IntegrationStatusResponse,
    MetadataSyncResponse,
)
from app.services.integration_service import IntegrationService
from app.services.salesforce_oauth_service import SalesforceOAuthService
from app.services.metadata_sync_worker import MetadataSyncWorker

router = APIRouter()


# ──────────────────────────────────────────────
# Connect / Disconnect
# ──────────────────────────────────────────────

@router.post("/projects/{project_id}/connect")
async def connect_project(
    project_id: UUID,
    payload: Dict[str, Any],
    db: AsyncSession = Depends(get_db),
):
    """
    Connect a project to a Web App, Salesforce org, or API service.

    Web App:   { "category": "web_app", "base_url": "...", "username": "...", "password": "...", "login_strategy": "form" }
    Salesforce:{ "category": "salesforce" }  → returns OAuth URL
    API:       { "category": "api", "base_url": "...", "api_key": "...", "bearer_token": "..." }
    """
    category = payload.get("category", "").lower()

    if category == "web_app":
        base_url = payload.get("base_url")
        if not base_url:
            raise HTTPException(status_code=400, detail="base_url is required for web_app")

        integration = await IntegrationService.create_web_integration(
            db=db,
            project_id=project_id,
            base_url=base_url,
            username=payload.get("username"),
            password=payload.get("password"),
            login_strategy=payload.get("login_strategy", "form"),
        )
        return {
            "status": "connected",
            "category": "web_app",
            "integration_id": str(integration.id),
            "message": "Web application connected successfully",
        }

    elif category == "salesforce":
        try:
            # get_auth_url now reads from DB (per-project) with env fallback
            auth_url = await SalesforceOAuthService.get_auth_url(
                db=db, project_id=project_id,
            )
            return {
                "status": "pending_oauth",
                "category": "salesforce",
                "auth_url": auth_url,
                "message": "Redirect user to auth_url to complete Salesforce OAuth",
            }
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    elif category == "api":
        integration = await IntegrationService.create_api_integration(
            db=db,
            project_id=project_id,
            base_url=payload.get("base_url"),
            api_key=payload.get("api_key"),
            bearer_token=payload.get("bearer_token"),
        )
        return {
            "status": "connected",
            "category": "api",
            "integration_id": str(integration.id),
            "message": "API integration connected successfully",
        }

    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported category: '{category}'. Use 'web_app', 'salesforce', or 'api'.",
        )


@router.delete("/projects/{project_id}/disconnect", status_code=204)
async def disconnect_project(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Remove the integration for a project."""
    deleted = await IntegrationService.delete_integration(db, project_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="No integration found for this project")
    return None


# ──────────────────────────────────────────────
# Salesforce Connected App Credentials
# ──────────────────────────────────────────────

@router.post("/projects/{project_id}/save-sf-credentials")
async def save_sf_credentials(
    project_id: UUID,
    payload: SalesforceCredentialsRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Save per-project Salesforce Connected App credentials.
    Must be called BEFORE triggering the OAuth flow.
    Credentials are encrypted at rest.
    """
    integration = await IntegrationService.save_sf_credentials(
        db=db,
        project_id=project_id,
        client_id=payload.client_id,
        client_secret=payload.client_secret,
        redirect_uri=payload.redirect_uri,
        login_url=payload.login_url or "https://login.salesforce.com",
        sf_username=payload.sf_username,
        sf_password=payload.sf_password,
    )
    return {
        "status": "credentials_saved",
        "integration_id": str(integration.id),
        "message": "Connected App credentials saved. You can now initiate OAuth.",
        "redirect_uri": integration.salesforce_redirect_uri,
        "login_url": integration.salesforce_login_url,
    }


# ──────────────────────────────────────────────
# Integration Status
# ──────────────────────────────────────────────

@router.get("/projects/{project_id}/integration-status")
async def get_integration_status(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get the connection status + metadata sync counts + session info for a project."""
    from app.services.session_service import SessionService

    integration = await IntegrationService.get_integration(db, project_id)
    session_status = await SessionService.get_session_status(db, project_id)

    if not integration:
        return {
            "status": "disconnected",
            "category": None,
            "message": "No integration configured for this project",
            "sync_counts": None,
            "ui_session": session_status,
        }

    sync_counts = await MetadataSyncWorker.get_sync_counts(db, project_id)

    return {
        "id": str(integration.id),
        "project_id": str(integration.project_id),
        "category": integration.category,
        "status": integration.status,
        "base_url": integration.base_url,
        "instance_url": integration.instance_url,
        "login_strategy": integration.login_strategy,
        "org_id": integration.org_id,
        "salesforce_login_url": integration.salesforce_login_url,
        "has_sf_credentials": bool(integration.client_id) if integration.category == "salesforce" else None,
        "mcp_connected": bool(integration.mcp_connected),
        "last_synced_at": integration.last_synced_at.isoformat() if integration.last_synced_at else None,
        "sync_error": integration.sync_error,
        "sync_counts": sync_counts,
        "ui_session": session_status,
        "created_at": integration.created_at.isoformat() if integration.created_at else None,
        "updated_at": integration.updated_at.isoformat() if integration.updated_at else None,
    }


# ──────────────────────────────────────────────
# Salesforce OAuth
# ──────────────────────────────────────────────

@router.get("/integrations/salesforce/auth-url")
async def salesforce_auth_url(
    project_id: UUID = Query(..., description="Project to link the SF org to"),
    db: AsyncSession = Depends(get_db),
):
    """
    Get the Salesforce OAuth authorization URL.
    Uses per-project credentials from DB, falls back to env vars.
    """
    try:
        url = await SalesforceOAuthService.get_auth_url(db, project_id)
        return {"auth_url": url}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/integrations/salesforce/callback")
async def salesforce_callback(
    state: str = Query(...),  # project_id
    code: str = Query(None),
    error: str = Query(None),
    error_description: str = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """
    Salesforce OAuth callback.
    Exchanges code for tokens using per-project credentials.
    Handles OAuth errors (e.g., authorization blocked).
    Triggers metadata sync automatically.
    """
    # Handle OAuth error from Salesforce
    if error or not code:
        err_msg = error_description or error or "OAuth authorization failed"
        return RedirectResponse(
            url=f"http://localhost:3000/dashboard/projects/{state}?error={err_msg}",
            status_code=302,
        )

    try:
        result = await SalesforceOAuthService.handle_callback(
            db=db, code=code, state=state
        )

        # Auto-trigger metadata sync
        try:
            sync_result = await MetadataSyncWorker.sync_metadata(db, UUID(state))
            logger.info(f"[metadata_sync] Auto-sync result for project {state}: {sync_result}")
        except Exception as sync_err:
            logger.error(f"[metadata_sync] Auto-sync after OAuth failed for project {state}: {sync_err}", exc_info=True)

        # Redirect back to project page
        return RedirectResponse(
            url=f"http://localhost:3000/dashboard/projects/{state}?connected=salesforce",
            status_code=302,
        )

    except Exception as e:
        return RedirectResponse(
            url=f"http://localhost:3000/dashboard/projects/{state}?error={str(e)}",
            status_code=302,
        )


# ──────────────────────────────────────────────
# Metadata Sync
# ──────────────────────────────────────────────

@router.post("/projects/{project_id}/sync-metadata", response_model=MetadataSyncResponse)
async def sync_metadata(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Trigger a metadata sync for a connected project."""
    result = await MetadataSyncWorker.sync_metadata(db, project_id)
    return MetadataSyncResponse(**result)
