@echo off
echo ==============================================
echo      Starting AutoTestAI Environment
echo ==============================================

echo [1] Initializing Docker Databases (Postgres on 5434, Redis on 6380)
docker compose up db redis -d --remove-orphans

echo [2] Starting FastAPI Backend on Port 8000
start "AutoTestAI Backend" cmd /k "cd backend && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"

echo [3] Starting Clean Next.js Frontend on Port 3002
start "AutoTestAI Frontend" cmd /k "cd frontend && npm run dev -- -p 3002"

echo ==============================================
echo   Startup Complete!
echo   Frontend: http://localhost:3002
echo   Backend APIs: http://localhost:8000/docs
echo ==============================================
pause
