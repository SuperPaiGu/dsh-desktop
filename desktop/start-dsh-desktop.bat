@echo off
setlocal
rem Lives inside dsh-desktop, so the app dir is this bat's own directory.
set "APP_DIR=%~dp0"

if exist "%APP_DIR%\node_modules\electron\dist\electron.exe" goto run

echo First run: installing desktop shell dependencies (network required)...
pushd "%APP_DIR%"
where pnpm >nul 2>nul
if not errorlevel 1 (
  call pnpm install
) else (
  call npm install
)
if errorlevel 1 (
  popd
  echo.
  echo Install failed - check network and run this again.
  pause
  exit /b 1
)
popd

:run
start "" /D "%APP_DIR%" "%APP_DIR%\node_modules\electron\dist\electron.exe" "."
