@echo off
rem STANDALONE / TESTING ONLY. In normal use Chrome starts the monitor by itself
rem (Native Messaging - see install_host.py), so students never run this file.
rem This enforces the whole time the window is open, without the extension.
cd /d "%~dp0"
python exam_monitor.py --always
pause
