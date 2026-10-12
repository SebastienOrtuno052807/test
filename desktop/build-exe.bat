@echo off
REM Build OpenReader.exe on Windows — just double-click this file.
REM Requires: Python 3.12 from https://www.python.org/downloads/ (check "Add python.exe to PATH")
setlocal

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Install Python 3.12 from python.org and check "Add python.exe to PATH".
  pause
  exit /b 1
)

echo [1/3] Installing dependencies...
python -m pip install --upgrade pip
python -m pip install -r requirements.txt pyinstaller
if errorlevel 1 ( echo [ERROR] pip install failed. & pause & exit /b 1 )

echo [2/3] Building OpenReader.exe with PyInstaller...
python -m PyInstaller OpenReader.spec --noconfirm
if errorlevel 1 ( echo [ERROR] Build failed. & pause & exit /b 1 )

echo [3/3] Done!
echo.
echo   Your app is at: dist\OpenReader\OpenReader.exe
echo   Double-click it to launch OpenReader. Your data is stored in %%USERPROFILE%%\OpenReader
echo.
pause
