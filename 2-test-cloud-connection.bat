@echo off
cd /d "%~dp0"
call node test-mongo.js
pause
