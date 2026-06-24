@echo off
REM Minimap Maker - double-click to run. Starts the local server and opens
REM your browser. Requires Python 3 with Flask installed:
REM     pip install -r requirements.txt

title Minimap Maker
cd /d "%~dp0"
start "" "http://127.0.0.1:5001/"
python backend\app.py
pause
