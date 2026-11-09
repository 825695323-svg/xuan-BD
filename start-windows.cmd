@echo off
setlocal
cd /d "%~dp0"
set "FIRST=%~1"
if "%FIRST:~0,7%"=="--node=" goto native
rem Default remains the strictly verified bundled runtime; never search PATH.
"%~dp0resources\bundled\win32-x64\node\node.exe" --import tsx "%~dp0scripts\web.ts" %*
exit /b %errorlevel%
:native
set "NODE=%FIRST:~7%"
if not "%NODE:~1,2%"==":\" if not "%NODE:~0,2%"=="\\" goto invalid
if not exist "%NODE%" goto invalid
if "%~2"=="" goto invalid
if not "%~3"=="" goto invalid
"%NODE%" "%~dp0scripts\local-web.mjs" start "%~2"
exit /b %errorlevel%
:invalid
echo Native usage: start-windows.cmd "--node=C:\absolute\node.exe" "--launcher=C:\absolute\new-launcher.json" 1>&2
exit /b 1
