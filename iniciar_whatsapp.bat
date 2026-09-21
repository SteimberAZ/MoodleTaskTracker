@echo off
title Servidor de WhatsApp - Moodle Task Tracker
cd /d "%~dp0whatsapp_bot"
echo ========================================================
echo   INICIANDO SERVIDOR DE WHATSAPP PARA ALERTAS DE MOODLE
echo ========================================================
echo.
echo Abriendo landing en: http://localhost:3000 ...
start http://localhost:3000
echo.
node server.js
pause
