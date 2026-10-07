@echo off
cd /d "%~dp0"
echo This copies the shop data from the cloud database to this PC and switches
echo this PC to work WITHOUT internet. The cloud data is not changed.
echo Close the billing app before you continue.
echo.
pause
call node copy-cloud-data-to-this-pc.js
echo.
pause
