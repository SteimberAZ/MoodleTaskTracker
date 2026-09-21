@echo off
setlocal
title Compilador Rapido - Moodle Task Tracker
echo ========================================================
echo       COMPILADOR RAPIDO A .EXE - MOODLE TASK TRACKER
echo ========================================================
echo.

cd /d "%~dp0"

echo [1/3] Verificando dependencias necesarias...
python -m pip install -r requirements.txt
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] No se pudieron instalar las dependencias.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [2/3] Compilando ejecutable con PyInstaller e icono integrado...
pyinstaller --noconsole --onefile --icon="icon.ico" --add-data="icon.ico;." --add-data="icon.png;." --collect-all customtkinter --name="MoodleTracker" --clean app.py
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Ocurrio un error durante la compilacion.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [3/3] Moviendo ejecutable a la raiz del proyecto...
if exist "dist\MoodleTracker.exe" (
    copy /y "dist\MoodleTracker.exe" "MoodleTracker.exe" >nul
    echo [OK] MoodleTracker.exe listo en la carpeta principal.
)

echo.
echo ========================================================
echo   COMPILACION EXITOSA! Ya puedes usar MoodleTracker.exe
echo ========================================================
echo.
pause
