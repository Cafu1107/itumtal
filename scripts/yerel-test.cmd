@echo off
rem Yerel test ortamı: API (wrangler dev, yerel D1) + site, sonra tarayıcıyı açar.
rem Canlı siteye ve canlı veritabanına dokunmaz.
cd /d "%~dp0..\worker"
if not exist node_modules call npm install
call npx wrangler d1 migrations apply itumtal-ziyaret --local
start "itumtal API" cmd /k npx wrangler dev --port 8787 --ip 127.0.0.1
start "itumtal site" cmd /k python -m http.server 5500 --bind 127.0.0.1 --directory "%~dp0..\site"
timeout /t 6 >nul
start "" http://localhost:5500/
start "" http://localhost:5500/panel/
