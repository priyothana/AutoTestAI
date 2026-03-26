@echo off
cd /d "%~dp0"
title Backend API (Port 8000)
echo Starting FastAPI Backend with hot-reloading...
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
