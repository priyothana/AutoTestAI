"""
Salesforce UI Session Service

Centralized management of Playwright browser sessions for Salesforce projects.
Sessions are persisted as storageState.json files per project and tracked in the DB.
"""
import os
import logging
from uuid import UUID
from datetime import datetime
from typing import Optional, Dict, Any

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from app.models.project import Project

logger = logging.getLogger(__name__)

# Session file directory
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SESSIONS_DIR = os.path.join(_BACKEND_DIR, "sessions")
os.makedirs(SESSIONS_DIR, exist_ok=True)


class SessionService:
    """Manages Playwright browser session lifecycle for Salesforce projects."""

    @staticmethod
    def get_session_path(project_id: str) -> str:
        """Return the absolute path to a project's storageState.json."""
        return os.path.join(SESSIONS_DIR, f"{project_id}.json")

    @staticmethod
    def session_file_exists(project_id: str) -> bool:
        """Check if the session file exists on disk."""
        path = SessionService.get_session_path(project_id)
        return os.path.exists(path) and os.path.getsize(path) > 0

    @staticmethod
    async def has_valid_session(db: AsyncSession, project_id: UUID) -> bool:
        """Check if a valid session exists (file on disk + DB flag active)."""
        result = await db.execute(
            select(Project).where(Project.id == project_id)
        )
        project = result.scalars().first()
        if not project or not project.ui_session_active:
            return False
        return SessionService.session_file_exists(str(project_id))

    @staticmethod
    async def save_session(
        db: AsyncSession,
        project_id: UUID,
        source: str = "login_test",
    ) -> None:
        """
        Mark session as active in the DB after storage_state file has been saved.
        source: 'oauth' or 'login_test'
        """
        result = await db.execute(
            select(Project).where(Project.id == project_id)
        )
        project = result.scalars().first()
        if not project:
            logger.error(f"Cannot save session: project {project_id} not found")
            return

        project.ui_session_active = True
        project.ui_session_source = source
        project.ui_session_last_created_at = datetime.utcnow()
        await db.commit()
        logger.info(f"[SESSION] Marked session active for project {project_id} (source={source})")

    @staticmethod
    async def invalidate_session(db: AsyncSession, project_id: UUID) -> None:
        """Delete session file and clear DB flags."""
        # Delete file
        path = SessionService.get_session_path(str(project_id))
        if os.path.exists(path):
            os.remove(path)
            logger.info(f"[SESSION] Deleted session file for project {project_id}")

        # Clear DB
        result = await db.execute(
            select(Project).where(Project.id == project_id)
        )
        project = result.scalars().first()
        if project:
            project.ui_session_active = False
            project.ui_session_source = None
            await db.commit()
            logger.info(f"[SESSION] Cleared session DB flags for project {project_id}")

    @staticmethod
    async def get_session_status(db: AsyncSession, project_id: UUID) -> Dict[str, Any]:
        """Return session status for API response."""
        result = await db.execute(
            select(Project).where(Project.id == project_id)
        )
        project = result.scalars().first()
        if not project:
            return {"active": False, "source": None, "last_created_at": None}

        file_exists = SessionService.session_file_exists(str(project_id))

        # If DB says active but file is missing → expired
        if project.ui_session_active and not file_exists:
            status = "expired"
        elif project.ui_session_active and file_exists:
            status = "active"
        else:
            status = "not_created"

        return {
            "active": project.ui_session_active and file_exists,
            "status": status,
            "source": project.ui_session_source,
            "last_created_at": (
                project.ui_session_last_created_at.isoformat()
                if project.ui_session_last_created_at
                else None
            ),
        }
