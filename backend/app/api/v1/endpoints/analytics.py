from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, case, Date, cast
from typing import List
from datetime import datetime, timedelta

from app.db.session import get_db
from app.models.test_run import TestRun
from app.models.test_case import TestCase
from app.models.project import Project
from app.schemas.analytics import (
    DashboardStats, 
    StatusDistribution, 
    DailyTrend, 
    ProjectExecutionSummary,
    TopFailedTestCase
)

router = APIRouter()

@router.get("/dashboard-stats", response_model=DashboardStats)
async def get_dashboard_stats(db: AsyncSession = Depends(get_db)):
    # Total Projects
    projects_count = await db.execute(select(func.count(Project.id)))
    total_projects = projects_count.scalar() or 0
    
    # Total Test Cases
    tests_count = await db.execute(select(func.count(TestCase.id)))
    total_test_cases = tests_count.scalar() or 0
    
    # Total Executions
    executions_count = await db.execute(select(func.count(TestRun.id)))
    total_executions = executions_count.scalar() or 0
    
    # Pass Rate
    passed_count = await db.execute(select(func.count(TestRun.id)).where(TestRun.result == "passed"))
    total_passed = passed_count.scalar() or 0
    
    pass_rate = (total_passed / total_executions * 100) if total_executions > 0 else 0
    
    return DashboardStats(
        total_projects=total_projects,
        total_test_cases=total_test_cases,
        total_executions=total_executions,
        pass_rate=round(pass_rate, 2)
    )

@router.get("/execution-distribution", response_model=List[StatusDistribution])
async def get_execution_distribution(db: AsyncSession = Depends(get_db)):
    query = select(TestRun.result, func.count(TestRun.id)).group_by(TestRun.result)
    result = await db.execute(query)
    
    return [StatusDistribution(result=row[0] or "unknown", count=row[1]) for row in result]

@router.get("/reports/trend", response_model=List[DailyTrend])
async def get_execution_trend(db: AsyncSession = Depends(get_db)):
    seven_days_ago = datetime.utcnow() - timedelta(days=7)
    
    query = (
        select(
            cast(TestRun.created_at, Date).label("date"),
            func.sum(case((TestRun.result == "passed", 1), else_=0)).label("passed"),
            func.sum(case((TestRun.result == "failed", 1), else_=0)).label("failed")
        )
        .where(TestRun.created_at >= seven_days_ago)
        .group_by(cast(TestRun.created_at, Date))
        .order_by("date")
    )
    
    result = await db.execute(query)
    return [DailyTrend(date=row[0], passed=row[1], failed=row[2]) for row in result]

@router.get("/reports/projects", response_model=List[ProjectExecutionSummary])
async def get_project_execution_summary(db: AsyncSession = Depends(get_db)):
    query = (
        select(
            Project.name,
            func.count(TestRun.id).label("total_runs"),
            func.sum(case((TestRun.result == "passed", 1), else_=0)).label("passed"),
            func.sum(case((TestRun.result == "failed", 1), else_=0)).label("failed")
        )
        .join(TestCase, Project.id == TestCase.project_id)
        .join(TestRun, TestCase.id == TestRun.test_case_id)
        .group_by(Project.name)
    )
    
    result = await db.execute(query)
    return [
        ProjectExecutionSummary(
            project_name=row[0],
            total_runs=row[1],
            passed=row[2],
            failed=row[3]
        ) for row in result
    ]

@router.get("/reports/top-failed", response_model=List[TopFailedTestCase])
async def get_top_failed_tests(db: AsyncSession = Depends(get_db)):
    query = (
        select(TestCase.name, func.count(TestRun.id).label("fail_count"))
        .join(TestRun, TestCase.id == TestRun.test_case_id)
        .where(TestRun.result == "failed")
        .group_by(TestCase.name)
        .order_by(func.count(TestRun.id).desc())
        .limit(5)
    )
    
    result = await db.execute(query)
    return [TopFailedTestCase(name=row[0], fail_count=row[1]) for row in result]
