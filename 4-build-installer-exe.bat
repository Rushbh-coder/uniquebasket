@echo off
cd /d "%~dp0"
echo Closing any running Wholesale Billing / Electron windows...
taskkill /F /IM "Wholesale Billing.exe" >nul 2>&1
taskkill /F /IM electron.exe >nul 2>&1
timeout /t 2 >nul
if exist release rmdir /s /q release
echo Building installer (takes 2-5 minutes)... messages are saved in build-log.txt
call npm run dist > build-log.txt 2>&1
if exist "release\Wholesale Billing Setup 3.0.0.exe" (
  echo.
  echo SUCCESS: release\Wholesale Billing Setup 3.0.0.exe
  explorer release
) else (
  echo.
  echo BUILD FAILED. Last lines of build-log.txt:
  powershell -NoProfile -Command "Get-Content build-log.txt -Tail 25"
)
pause
