@echo off
title Moodle Task Tracker + WhatsApp Alerts
cd /d "%~dp0"
echo ========================================================
echo       MOODLE TASK TRACKER + WHATSAPP ALERTS
echo ========================================================
echo.
echo [1/2] Iniciando servidor local de WhatsApp en segundo plano...
start /b cmd /c "cd /d "%~dp0whatsapp_bot" && node server.js"
timeout /t 2 /nobreak >nul

echo [2/2] Iniciando aplicacion de escritorio Moodle Task Tracker...
python app.py
if %ERRORLEVEL% NEQ 0 (
    if exist "MoodleTracker.exe" (
        MoodleTracker.exe
    )
)
