@echo off
rem Starts the 4D generator (127.0.0.1:8766) and the viewer (HTTPS on port 5180, reachable from
rem the Quest on the LAN) in their own windows, skipping whichever is already running, then opens
rem the viewer in the browser. The viewer window shows the address to open on the Quest.
cd /d "%~dp0viewer"

rem Home-network IPv4 (a private address on an adapter with a gateway), for the Quest URL.
set "LANIP="
for /f %%a in ('powershell -NoProfile -Command "(Get-NetIPConfiguration | ? { $_.IPv4DefaultGateway } | %% { $_.IPv4Address.IPAddress } | ? { $_ -match '^(192\.168|10)\.|^172\.(1[6-9]|2\d|3[01])\.' } | Select -First 1)"') do set "LANIP=%%a"
if defined LANIP (set "QUEST=On the Quest browser open: https://%LANIP%:5180") else (set "QUEST=No home-network address found; is Wi-Fi connected?")

curl -s -o nul http://127.0.0.1:8766/scenes || start "4DGS generator" cmd /k npm run generator
curl -sk -o nul https://localhost:5180/ || start "4DGS viewer - %QUEST%" cmd /k "echo. & echo   %QUEST%   (accept the certificate warning once) & echo. & npm run dev:quest"

for /l %%i in (1,1,30) do (
  curl -sk -o nul https://localhost:5180/ && goto open
  timeout /t 1 /nobreak >nul
)
:open
start "" https://localhost:5180/
