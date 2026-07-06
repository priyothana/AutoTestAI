@echo off
echo ==============================================
echo      Starting AutoTestAI Environment
echo ==============================================

echo [1] Initializing Docker Databases (Postgres on 5434, Redis on 6380)
docker compose up db redis -d --remove-orphans

echo [2] Starting Node.js Backend on Port 4000
start "AutoTestAI Backend" cmd /k "cd services/api && npm run dev"

echo [3] Starting Clean Next.js Frontend on Port 3002
start "AutoTestAI Frontend" cmd /k "cd frontend && npm run dev -- -p 3002"

echo ==============================================
echo   Startup Complete!
echo   Frontend: http://localhost:3002
echo   Backend API: http://localhost:4000
echo   API Health: http://localhost:4000/health
echo ==============================================
pause
