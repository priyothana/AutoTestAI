"""
MCP (Model Context Protocol) API Endpoints for Salesforce

Provides direct Salesforce API access via username/password/security_token
authentication. Supports CRUD operations, SOQL queries, SOSL search,
object metadata, and org limits.
"""
import logging
from typing import Dict, Any, Optional, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.services.integration_service import IntegrationService, _decrypt
from app.services.salesforce_mcp_service import SalesforceMCPService
from app.services.metadata_sync_worker import MetadataSyncWorker
from app.schemas.integration import (
    McpConnectRequest,
    McpQueryRequest,
    McpRecordRequest,
    McpSearchRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ──────────────────────────────────────────────
# Helper: Get decrypted MCP credentials
# ──────────────────────────────────────────────

async def _get_mcp_creds(db: AsyncSession, project_id: UUID) -> dict:
    """Retrieve and decrypt MCP credentials for a project."""
    integration = await IntegrationService.get_integration(db, project_id)
    if not integration or not integration.mcp_connected:
        raise HTTPException(
            status_code=400,
            detail="No MCP connection found for this project. Please connect via MCP first.",
        )

    tokens = await IntegrationService.get_decrypted_tokens(integration)
    username = tokens.get("username")
    password = tokens.get("password")
    security_token = tokens.get("security_token")

    if not username or not password or not security_token:
        raise HTTPException(
            status_code=400,
            detail="MCP credentials are incomplete. Please reconnect.",
        )

    domain = integration.salesforce_login_url or "login"
    # Extract domain string: if full URL, map to simple domain
    if "test.salesforce.com" in domain:
        domain = "test"
    elif domain not in ("login", "test"):
        domain = "login"

    return {
        "username": username,
        "password": password,
        "security_token": security_token,
        "domain": domain,
    }


# ──────────────────────────────────────────────
# MCP Connect
# ──────────────────────────────────────────────

@router.post("/projects/{project_id}/mcp-connect")
async def mcp_connect(
    project_id: UUID,
    payload: McpConnectRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Connect a Salesforce project via MCP using Username + Password + Security Token.
    Validates credentials by making a test connection.
    """
    try:
        # Validate credentials by connecting
        conn_info = SalesforceMCPService.connect(
            username=payload.sf_username,
            password=payload.sf_password,
            security_token=payload.sf_security_token,
            domain=payload.domain or "login",
        )

        # Store encrypted credentials
        integration = await IntegrationService.create_mcp_integration(
            db=db,
            project_id=project_id,
            username=payload.sf_username,
            password=payload.sf_password,
            security_token=payload.sf_security_token,
            instance_url=conn_info.get("instance_url", ""),
            org_id=conn_info.get("org_id"),
            domain=payload.domain or "login",
        )

        # Auto-trigger metadata sync (Extract → Normalize → DomainModel → Embed)
        sync_result = {}
        try:
            sync_result = await MetadataSyncWorker.sync_metadata(db, project_id)
            logger.info(f"[mcp] Auto metadata sync result for project {project_id}: {sync_result}")
        except Exception as sync_err:
            logger.error(f"[mcp] Auto metadata sync failed for project {project_id}: {sync_err}", exc_info=True)
            sync_result = {"status": "error", "message": str(sync_err)}

        return {
            "status": "connected",
            "category": "salesforce",
            "connection_type": "mcp",
            "integration_id": str(integration.id),
            "instance_url": conn_info.get("instance_url"),
            "org_id": conn_info.get("org_id"),
            "org_name": conn_info.get("org_name"),
            "api_version": conn_info.get("api_version"),
            "metadata_sync": sync_result,
            "message": "Salesforce MCP connection established successfully",
        }

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"[mcp] Connection failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"MCP connection failed: {str(e)}")


# ──────────────────────────────────────────────
# SOQL Query
# ──────────────────────────────────────────────

@router.post("/projects/{project_id}/mcp/query")
async def mcp_query(
    project_id: UUID,
    payload: McpQueryRequest,
    db: AsyncSession = Depends(get_db),
):
    """Execute a SOQL query against the connected Salesforce org."""
    creds = await _get_mcp_creds(db, project_id)

    try:
        result = SalesforceMCPService.query(
            username=creds["username"],
            password=creds["password"],
            security_token=creds["security_token"],
            soql=payload.query,
            domain=creds["domain"],
            include_deleted=payload.include_deleted,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ──────────────────────────────────────────────
# Get Record
# ──────────────────────────────────────────────

@router.get("/projects/{project_id}/mcp/records/{object_type}/{record_id}")
async def mcp_get_record(
    project_id: UUID,
    object_type: str,
    record_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get a specific Salesforce record by object type and record ID."""
    creds = await _get_mcp_creds(db, project_id)

    try:
        result = SalesforceMCPService.get_record(
            username=creds["username"],
            password=creds["password"],
            security_token=creds["security_token"],
            object_type=object_type,
            record_id=record_id,
            domain=creds["domain"],
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ──────────────────────────────────────────────
# Create Record
# ──────────────────────────────────────────────

@router.post("/projects/{project_id}/mcp/records/{object_type}")
async def mcp_create_record(
    project_id: UUID,
    object_type: str,
    payload: McpRecordRequest,
    db: AsyncSession = Depends(get_db),
):
    """Create a new Salesforce record."""
    creds = await _get_mcp_creds(db, project_id)

    try:
        result = SalesforceMCPService.create_record(
            username=creds["username"],
            password=creds["password"],
            security_token=creds["security_token"],
            object_type=object_type,
            data=payload.data,
            domain=creds["domain"],
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ──────────────────────────────────────────────
# Update Record
# ──────────────────────────────────────────────

@router.put("/projects/{project_id}/mcp/records/{object_type}/{record_id}")
async def mcp_update_record(
    project_id: UUID,
    object_type: str,
    record_id: str,
    payload: McpRecordRequest,
    db: AsyncSession = Depends(get_db),
):
    """Update an existing Salesforce record."""
    creds = await _get_mcp_creds(db, project_id)

    try:
        result = SalesforceMCPService.update_record(
            username=creds["username"],
            password=creds["password"],
            security_token=creds["security_token"],
            object_type=object_type,
            record_id=record_id,
            data=payload.data,
            domain=creds["domain"],
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ──────────────────────────────────────────────
# Delete Record
# ──────────────────────────────────────────────

@router.delete("/projects/{project_id}/mcp/records/{object_type}/{record_id}")
async def mcp_delete_record(
    project_id: UUID,
    object_type: str,
    record_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Delete a Salesforce record."""
    creds = await _get_mcp_creds(db, project_id)

    try:
        result = SalesforceMCPService.delete_record(
            username=creds["username"],
            password=creds["password"],
            security_token=creds["security_token"],
            object_type=object_type,
            record_id=record_id,
            domain=creds["domain"],
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ──────────────────────────────────────────────
# Describe Object
# ──────────────────────────────────────────────

@router.get("/projects/{project_id}/mcp/describe/{object_type}")
async def mcp_describe_object(
    project_id: UUID,
    object_type: str,
    db: AsyncSession = Depends(get_db),
):
    """Get metadata description of a Salesforce object."""
    creds = await _get_mcp_creds(db, project_id)

    try:
        result = SalesforceMCPService.describe_object(
            username=creds["username"],
            password=creds["password"],
            security_token=creds["security_token"],
            object_type=object_type,
            domain=creds["domain"],
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ──────────────────────────────────────────────
# SOSL Search
# ──────────────────────────────────────────────

@router.post("/projects/{project_id}/mcp/search")
async def mcp_search(
    project_id: UUID,
    payload: McpSearchRequest,
    db: AsyncSession = Depends(get_db),
):
    """Execute a SOSL search across multiple Salesforce objects."""
    creds = await _get_mcp_creds(db, project_id)

    try:
        result = SalesforceMCPService.search(
            username=creds["username"],
            password=creds["password"],
            security_token=creds["security_token"],
            sosl_query=payload.search_query,
            domain=creds["domain"],
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ──────────────────────────────────────────────
# Org Limits
# ──────────────────────────────────────────────

@router.get("/projects/{project_id}/mcp/limits")
async def mcp_limits(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get Salesforce org API limits and usage."""
    creds = await _get_mcp_creds(db, project_id)

    try:
        result = SalesforceMCPService.get_limits(
            username=creds["username"],
            password=creds["password"],
            security_token=creds["security_token"],
            domain=creds["domain"],
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ──────────────────────────────────────────────
# Manual Metadata Sync
# ──────────────────────────────────────────────

@router.post("/projects/{project_id}/mcp/sync-metadata")
async def mcp_sync_metadata(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """
    Manually trigger metadata sync for an MCP-connected project.
    Runs the full pipeline: Extract → Normalize → DomainModel → Embed.
    """
    # Verify MCP connection exists
    await _get_mcp_creds(db, project_id)

    try:
        result = await MetadataSyncWorker.sync_metadata(db, project_id)
        return result
    except Exception as e:
        logger.error(f"[mcp] Manual metadata sync failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Metadata sync failed: {str(e)}")
