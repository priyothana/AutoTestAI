"""
Jira API Endpoints
Provides connect, boards, board-issues endpoints for ad-hoc use,
plus project-level config/stories endpoints for stored Jira integrations.
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.services import jira_service
from app.services.integration_service import IntegrationService
from app.db.session import get_db

router = APIRouter()


# ─── Request Schemas ─────────────────────────

class JiraCredentials(BaseModel):
    """Base credentials for all Jira API calls."""
    domain: str
    email: str
    api_token: str


class JiraBoardIssuesRequest(JiraCredentials):
    """Request to fetch issues from a specific board."""
    board_id: str
    max_results: int = 50


class JiraConfigSaveRequest(BaseModel):
    """Save Jira configuration to a project."""
    domain: str
    email: str
    api_token: str
    board_id: str
    board_name: str


# ─── Ad-hoc Endpoints (credentials per-request) ─────────

@router.post("/connect")
async def jira_connect(creds: JiraCredentials):
    """
    Validate Jira credentials by calling /rest/api/3/myself.
    Returns connection status and user info.
    """
    try:
        user_info = await jira_service.connect(
            domain=creds.domain,
            email=creds.email,
            api_token=creds.api_token,
        )
        return {
            "connected": True,
            "user_name": user_info.get("display_name", ""),
            "email": user_info.get("email", ""),
        }
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Could not connect to Jira: {str(e)}",
        )


@router.post("/boards")
async def jira_boards(creds: JiraCredentials):
    """
    Fetch all Jira boards accessible to the authenticated user.
    """
    try:
        boards = await jira_service.get_boards(
            domain=creds.domain,
            email=creds.email,
            api_token=creds.api_token,
        )
        return {"boards": boards}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch Jira boards: {str(e)}",
        )


@router.post("/board-issues")
async def jira_board_issues(req: JiraBoardIssuesRequest):
    """
    Fetch user stories (Story issue type) from a specific Jira board.
    """
    try:
        issues = await jira_service.get_board_issues(
            domain=req.domain,
            email=req.email,
            api_token=req.api_token,
            board_id=req.board_id,
            max_results=req.max_results,
        )
        return {"issues": issues}
    except ValueError as e:
        status = 404 if "not found" in str(e).lower() else 400
        raise HTTPException(status_code=status, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch board issues: {str(e)}",
        )


# ─── Project-level Jira Config Endpoints ─────

@router.post("/projects/{project_id}/config")
async def save_jira_config(
    project_id: UUID,
    req: JiraConfigSaveRequest,
    db: AsyncSession = Depends(get_db),
):
    """Save Jira configuration (domain, email, token, board) at the project level."""
    try:
        # Validate credentials first
        await jira_service.connect(
            domain=req.domain,
            email=req.email,
            api_token=req.api_token,
        )
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Jira validation failed: {str(e)}")

    integration = await IntegrationService.save_jira_config(
        db=db,
        project_id=project_id,
        domain=req.domain,
        email=req.email,
        token=req.api_token,
        board_id=req.board_id,
        board_name=req.board_name,
    )
    return {
        "status": "saved",
        "jira_board_id": integration.jira_board_id,
        "jira_board_name": integration.jira_board_name,
    }


@router.get("/projects/{project_id}/config")
async def get_jira_config(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get Jira configuration for a project (token is hidden)."""
    config = await IntegrationService.get_jira_config(db, project_id)
    if not config:
        return {"configured": False}
    return {
        "configured": True,
        "jira_domain": config["jira_domain"],
        "jira_email": config["jira_email"],
        "jira_board_id": config["jira_board_id"],
        "jira_board_name": config["jira_board_name"],
        # Token is never sent to the frontend
    }


@router.get("/projects/{project_id}/stories")
async def get_jira_stories(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Fetch user stories from the Jira board stored in this project's config."""
    config = await IntegrationService.get_jira_config(db, project_id)
    if not config:
        raise HTTPException(
            status_code=404,
            detail="Jira integration is not configured for this project. Please configure Jira in Project Settings.",
        )

    try:
        issues = await jira_service.get_board_issues(
            domain=config["jira_domain"],
            email=config["jira_email"],
            api_token=config["jira_token"],
            board_id=config["jira_board_id"],
        )
        return {
            "board_name": config["jira_board_name"],
            "issues": issues,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch stories: {str(e)}",
        )
