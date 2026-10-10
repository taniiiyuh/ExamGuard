@echo off
rem Started by Chrome (Native Messaging). Do NOT add "pause" or any echo/output here:
rem stdout is the message channel between Chrome and the monitor.
rem If "python" is not found when Chrome runs this, put its full path instead, e.g.
rem   "C:\Users\Public\Python312\python.exe" exam_monitor.py %*
cd /d "%~dp0"
python exam_monitor.py %*
