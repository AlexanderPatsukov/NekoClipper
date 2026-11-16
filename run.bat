@echo off
title NekoClipper
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8

if exist .venv\Scripts\python.exe goto :run

rem ---------- first run: find Python, install it if missing ----------
set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY where python >nul 2>nul && python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul && set PY=python
if not defined PY (
  echo Python not found. Installing Python 3.12 via winget...
  winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
  if errorlevel 1 goto :nopython
  if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
    set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
  ) else (
    echo Python installed. Close this window and start run.bat again.
    pause
    goto :eof
  )
)

echo First run: creating environment and installing dependencies, this takes a few minutes...
%PY% -m venv .venv || goto :err
.venv\Scripts\python.exe -m pip install -q --upgrade pip
.venv\Scripts\python.exe -m pip install -q -r requirements.txt || goto :err

:run
.venv\Scripts\python.exe -m clipper %*
if errorlevel 1 pause
goto :eof

:nopython
echo Could not install Python automatically.
echo Download it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^) and start run.bat again.
pause
goto :eof

:err
echo Install failed. Check your internet connection and start run.bat again.
if exist .venv rmdir /s /q .venv
pause
