"""
Integration Service
Handles creating/reading/deleting project integrations with encrypted credential storage.
"""
from typing import Optional
from uuid import UUID
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from app.models.project_integration import ProjectIntegration
from app.core.config import settings

# ─── Encryption helpers ──────────────────────

def _get_cipher():
    """Return a Fernet cipher for encrypting/decrypting secrets."""
    from cryptography.fernet import Fernet
    key = settings.SALESFORCE_ENCRYPTION_KEY
    if not key:
        # Generate a deterministic fallback — NOT secure for production
        import base64, hashlib
        fallback = base64.urlsafe_b64encode(
            hashlib.sha256(settings.SECRET_KEY.encode()).digest()
        )
        key = fallback.decode()
    return Fernet(key.encode() if isinstance(key, str) else key)


def _encrypt(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return _get_cipher().encrypt(value.encode()).decode()


def _decrypt(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    try:
        return _get_cipher().decrypt(value.encode()).decode()
    except Exception:
        return "*** decryption failed ***"


# ─── Service methods ─────────────────────────

class IntegrationService:

    @staticmethod
    async def create_web_integration(
        db: AsyncSession,
        project_id: UUID,
        base_url: str,
        username: Optional[str] = None,
        password: Optional[str] = None,
        login_strategy: str = "form",
    ) -> ProjectIntegration:
        """Create a Web App integration with encrypted credentials."""
        await IntegrationService.delete_integration(db, project_id)

        integration = ProjectIntegration(
            project_id=project_id,
            category="web_app",
            status="connected",
            base_url=base_url,
            login_strategy=login_strategy,
            username=_encrypt(username),
            password=_encrypt(password),
        )
        db.add(integration)
        await db.commit()
        await db.refresh(integration)
        return integration

    @staticmethod
    async def save_sf_credentials(
        db: AsyncSession,
        project_id: UUID,
        client_id: str,
        client_secret: str,
        redirect_uri: Optional[str] = None,
        login_url: str = "https://login.salesforce.com",
        sf_username: Optional[str] = None,
        sf_password: Optional[str] = None,
    ) -> ProjectIntegration:
        """
        Save Salesforce Connected App credentials (before OAuth).
        Creates or updates the integration record.
        """
        # Check for existing integration
        existing = await IntegrationService.get_integration(db, project_id)

        if existing and existing.category == "salesforce":
            # Update existing record with new credentials
            existing.client_id = client_id
            existing.client_secret = _encrypt(client_secret)
            existing.salesforce_redirect_uri = redirect_uri or settings.SALESFORCE_REDIRECT_URI
            existing.salesforce_login_url = login_url
            if sf_username:
                existing.username = sf_username
            if sf_password:
                existing.password = _encrypt(sf_password)
            existing.status = "pending_oauth"
            await db.commit()
            await db.refresh(existing)
            return existing

        # Remove any non-salesforce integration
        await IntegrationService.delete_integration(db, project_id)

        integration = ProjectIntegration(
            project_id=project_id,
            category="salesforce",
            status="pending_oauth",
            client_id=client_id,
            client_secret=_encrypt(client_secret),
            salesforce_redirect_uri=redirect_uri or settings.SALESFORCE_REDIRECT_URI,
            salesforce_login_url=login_url,
            username=sf_username or "",
            password=_encrypt(sf_password) if sf_password else "",
        )
        db.add(integration)
        await db.commit()
        await db.refresh(integration)
        return integration

    @staticmethod
    async def create_sf_integration(
        db: AsyncSession,
        project_id: UUID,
        instance_url: str,
        access_token: str,
        refresh_token: Optional[str] = None,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        token_expiry: Optional[datetime] = None,
        org_id: Optional[str] = None,
    ) -> ProjectIntegration:
        """Create/update a Salesforce integration with encrypted OAuth tokens."""
        # Check if we have an existing record (from save_sf_credentials)
        existing = await IntegrationService.get_integration(db, project_id)

        if existing and existing.category == "salesforce":
            # Update existing record — preserve Connected App creds
            existing.instance_url = instance_url
            existing.access_token = _encrypt(access_token)
            existing.refresh_token = _encrypt(refresh_token)
            existing.token_expiry = token_expiry
            existing.status = "connected"
            existing.org_id = org_id
            # Only overwrite client_id/secret if provided (don't erase saved ones)
            if client_id:
                existing.client_id = client_id
            if client_secret:
                existing.client_secret = _encrypt(client_secret)
            await db.commit()
            await db.refresh(existing)
            return existing

        # No existing record — create fresh
        await IntegrationService.delete_integration(db, project_id)

        integration = ProjectIntegration(
            project_id=project_id,
            category="salesforce",
            status="connected",
            instance_url=instance_url,
            client_id=client_id,
            client_secret=_encrypt(client_secret),
            access_token=_encrypt(access_token),
            refresh_token=_encrypt(refresh_token),
            token_expiry=token_expiry,
            org_id=org_id,
        )
        db.add(integration)
        await db.commit()
        await db.refresh(integration)
        return integration

    @staticmethod
    async def create_api_integration(
        db: AsyncSession,
        project_id: UUID,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        bearer_token: Optional[str] = None,
    ) -> ProjectIntegration:
        """Create an API integration with encrypted key/token."""
        await IntegrationService.delete_integration(db, project_id)

        auth_config = {}
        if api_key:
            auth_config["api_key"] = _encrypt(api_key)
        if bearer_token:
            auth_config["bearer_token"] = _encrypt(bearer_token)

        integration = ProjectIntegration(
            project_id=project_id,
            category="api",
            status="connected",
            base_url=base_url,
            auth_config=auth_config,
        )
        db.add(integration)
        await db.commit()
        await db.refresh(integration)
        return integration

    @staticmethod
    async def create_mcp_integration(
        db: AsyncSession,
        project_id: UUID,
        username: str,
        password: str,
        security_token: str,
        instance_url: str = "",
        org_id: Optional[str] = None,
        domain: str = "login",
    ) -> ProjectIntegration:
        """Create/update a Salesforce integration via MCP (username/password/security_token)."""
        existing = await IntegrationService.get_integration(db, project_id)

        login_url = "https://test.salesforce.com" if domain == "test" else "https://login.salesforce.com"

        if existing and existing.category == "salesforce":
            existing.username = _encrypt(username)
            existing.password = _encrypt(password)
            existing.security_token = _encrypt(security_token)
            existing.instance_url = instance_url
            existing.org_id = org_id
            existing.salesforce_login_url = login_url
            existing.mcp_connected = True
            existing.status = "connected"
            await db.commit()
            await db.refresh(existing)
            return existing

        # Remove any existing non-salesforce integration
        await IntegrationService.delete_integration(db, project_id)

        integration = ProjectIntegration(
            project_id=project_id,
            category="salesforce",
            status="connected",
            username=_encrypt(username),
            password=_encrypt(password),
            security_token=_encrypt(security_token),
            instance_url=instance_url,
            org_id=org_id,
            salesforce_login_url=login_url,
            mcp_connected=True,
        )
        db.add(integration)
        await db.commit()
        await db.refresh(integration)
        return integration

    @staticmethod
    async def get_integration(
        db: AsyncSession, project_id: UUID
    ) -> Optional[ProjectIntegration]:
        """Get the integration for a project (at most one per project)."""
        result = await db.execute(
            select(ProjectIntegration).where(
                ProjectIntegration.project_id == project_id
            )
        )
        return result.scalars().first()

    @staticmethod
    async def get_decrypted_tokens(
        integration: ProjectIntegration,
    ) -> dict:
        """Return decrypted secrets for a given integration."""
        return {
            "username": _decrypt(integration.username),
            "password": _decrypt(integration.password),
            "security_token": _decrypt(integration.security_token),
            "access_token": _decrypt(integration.access_token),
            "refresh_token": _decrypt(integration.refresh_token),
            "client_secret": _decrypt(integration.client_secret),
        }

    @staticmethod
    async def delete_integration(
        db: AsyncSession, project_id: UUID
    ) -> bool:
        """Remove the integration for a project."""
        result = await db.execute(
            select(ProjectIntegration).where(
                ProjectIntegration.project_id == project_id
            )
        )
        integration = result.scalars().first()
        if integration:
            await db.delete(integration)
            await db.commit()
            return True
        return False

    @staticmethod
    async def update_sync_status(
        db: AsyncSession,
        integration: ProjectIntegration,
        status: str,
        error: Optional[str] = None,
    ):
        """Update the sync status of an integration."""
        integration.status = status
        integration.sync_error = error
        if status == "connected":
            integration.last_synced_at = datetime.utcnow()
        await db.commit()
        await db.refresh(integration)
