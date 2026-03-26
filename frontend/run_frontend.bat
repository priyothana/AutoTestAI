@echo off
cd /d "%~dp0"
title Frontend (Port 3002)
echo Starting Next.js Frontend on port 3002...
npm run dev -- -p 3002
