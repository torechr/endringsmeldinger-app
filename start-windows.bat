@echo off
chcp 65001 >nul
title Endringsmelding-Appen – Starter...

echo.
echo  ============================================
echo   Endringsmelding-Appen  ^|  NVDB V2
echo  ============================================
echo.

:: ── Sjekk om Node.js er installert ──────────────────────
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [!] Node.js er ikke installert.
    echo.
    echo  Aapner nedlastingssiden for Node.js...
    echo  Last ned LTS-versjonen, installer, og dobbelklikk
    echo  denne filen paa nytt naar installasjonen er ferdig.
    echo.
    start https://nodejs.org
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  [OK] Node.js %NODE_VER% funnet

:: ── Gå til mappen der skriptet ligger ───────────────────
cd /d "%~dp0"

:: ── Installer avhengigheter hvis nødvendig ───────────────
if not exist "node_modules\" (
    echo.
    echo  [..] Installerer avhengigheter (skjer bare første gang)...
    echo       Dette tar ca. 30 sekunder - ikke lukk vinduet.
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo  [!] npm install feilet. Sjekk internettilkobling og prøv igjen.
        pause
        exit /b 1
    )
    echo.
    echo  [OK] Avhengigheter installert!
) else (
    echo  [OK] Avhengigheter er allerede installert
)

:: ── Start appen ──────────────────────────────────────────
echo.
echo  [..] Starter appen...
echo.
echo  Nettleseren din aapnes automatisk om noen sekunder.
echo  Behold dette vinduet aapent mens du bruker appen.
echo  Lukk dette vinduet for aa stoppe appen.
echo.
echo  ============================================
echo.

:: Vent 2 sekunder, åpne nettleser, start dev-server
timeout /t 2 /nobreak >nul
start "" http://localhost:5173
call npm run dev

pause
