#!/bin/bash
# Endringsmelding-Appen – Mac-startskript
# Dobbelklikk denne filen for å starte appen

# Gå til mappen der skriptet ligger
cd "$(dirname "$0")"

clear
echo ""
echo "  ============================================"
echo "   Endringsmelding-Appen  |  NVDB V2"
echo "  ============================================"
echo ""

# ── Sjekk om Node.js er installert ──────────────────────
if ! command -v node &> /dev/null; then
    echo "  [!] Node.js er ikke installert."
    echo ""
    echo "  Åpner nedlastingssiden for Node.js..."
    echo "  Last ned LTS-versjonen, installer den,"
    echo "  og dobbelklikk denne filen på nytt."
    echo ""
    open "https://nodejs.org"
    echo "  Trykk Enter for å lukke dette vinduet."
    read
    exit 1
fi

NODE_VER=$(node --version)
echo "  [OK] Node.js $NODE_VER funnet"

# ── Installer avhengigheter hvis nødvendig ───────────────
if [ ! -d "node_modules" ]; then
    echo ""
    echo "  [..] Installerer avhengigheter (skjer bare første gang)..."
    echo "       Dette tar ca. 30 sekunder – ikke lukk vinduet."
    echo ""
    npm install
    if [ $? -ne 0 ]; then
        echo ""
        echo "  [!] npm install feilet. Sjekk internettilkobling og prøv igjen."
        echo "  Trykk Enter for å lukke."
        read
        exit 1
    fi
    echo ""
    echo "  [OK] Avhengigheter installert!"
else
    echo "  [OK] Avhengigheter er allerede installert"
fi

# ── Start appen ──────────────────────────────────────────
echo ""
echo "  [..] Starter appen..."
echo ""
echo "  Nettleseren din åpnes automatisk om noen sekunder."
echo "  Behold dette vinduet åpent mens du bruker appen."
echo "  Lukk dette vinduet for å stoppe appen."
echo ""
echo "  ============================================"
echo ""

# Vent litt, åpne nettleser, start dev-server
sleep 2
open "http://localhost:5173"
npm run dev
