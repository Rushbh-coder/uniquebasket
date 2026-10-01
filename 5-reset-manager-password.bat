@echo off
cd /d "%~dp0"
call node cloud.js --reset-admin
echo.
pause
