@echo off
title Moodle Task Tracker
cd /d "%~dp0"
python app.py
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Ocurrio un error al iniciar Moodle Task Tracker.
    echo Asegurate de tener instaladas las dependencias: pip install customtkinter requests beautifulsoup4 plyer pillow darkdetect
    echo.
    pause
)
