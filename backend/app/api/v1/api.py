from fastapi import APIRouter
from app.api.v1.endpoints import users, projects, tests, test_runs, ai, analytics, settings, salesforce, integrations, mcp

api_router = APIRouter()
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(projects.router, prefix="/projects", tags=["projects"])
api_router.include_router(tests.router, prefix="/tests", tags=["tests"])
api_router.include_router(test_runs.router, prefix="/test-runs", tags=["test-runs"])
api_router.include_router(ai.router, prefix="/ai", tags=["ai"])
api_router.include_router(analytics.router, prefix="/analytics", tags=["analytics"])
api_router.include_router(settings.router, prefix="/settings", tags=["settings"])
api_router.include_router(salesforce.router, prefix="/salesforce", tags=["salesforce"])
api_router.include_router(integrations.router, tags=["integrations"])
api_router.include_router(mcp.router, prefix="/mcp", tags=["mcp"])

