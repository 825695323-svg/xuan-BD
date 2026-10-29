@echo off
setlocal
cd /d "%~dp0"
"%~dp0resources\bundled\win32-x64\node\node.exe" --import tsx "%~dp0scripts\web.ts" %*
exit /b %errorlevel%
