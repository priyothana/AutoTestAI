from pydantic import BaseModel
from typing import List, Optional
from datetime import date

class DashboardStats(BaseModel):
    total_projects: int
    total_test_cases: int
    total_executions: int
    pass_rate: float

class StatusDistribution(BaseModel):
    result: str
    count: int

class DailyTrend(BaseModel):
    date: date
    passed: int
    failed: int

class ProjectExecutionSummary(BaseModel):
    project_name: str
    total_runs: int
    passed: int
    failed: int

class TopFailedTestCase(BaseModel):
    name: str
    fail_count: int
