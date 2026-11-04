@echo off
rem Edgeline relay — Windows. Fill in the four values, save, double-click.
rem Needs Node 22 or newer: https://nodejs.org (the LTS installer, defaults are fine).
rem Keep this window open; close it to stop the relay. Set Windows to never sleep while plugged in.

set EDGELINE_URL=https://YOUR-JOURNAL.onrender.com
set EDGELINE_RELAY_TOKEN=PASTE-THE-TOKEN-FROM-SETTINGS
set BINANCE_KEY=PASTE-YOUR-API-KEY
set BINANCE_SECRET=PASTE-YOUR-SECRET
rem For a futures testnet key, change the next line to: set BINANCE_ENV=testnet
set BINANCE_ENV=live

cd /d "%~dp0"
:again
node edgeline-relay.mjs
echo.
echo The relay stopped. Starting it again in 10 seconds (close this window to stop for good).
timeout /t 10 >nul
goto again
