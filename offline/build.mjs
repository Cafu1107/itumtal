// Builds the offline demo: a folder (and zip) that opens by double-click, with no internet.
//   cd offline && npm install && npm run build
// Output: offline/dist/ITU-MTAL-Tanitim/ and offline/dist/ITU-MTAL-Tanitim.zip
//
// Needs the network once (fonts, ExcelJS); those downloads are cached in offline/.cache.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SITE = join(REPO, 'site');
const NAME = 'ITU-MTAL-Tanitim';
const OUT = join(HERE, 'dist', NAME);
const OUT_SITE = join(OUT, 'site');
const OFF = join(OUT_SITE, 'assets', 'offline');
const CACHE = join(HERE, '.cache');

const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
const EXCELJS_SRI = 'sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz';
const FONT_CSS_URL = 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const PAGES = [
  { file: 'index.html', prefix: '' },
  { file: 'basvuru.html', prefix: '' },
  { file: 'takip.html', prefix: '' },
  { file: 'kvkk.html', prefix: '' },
  { file: 'panel/index.html', prefix: '../' },
];
const ENTRIES = ['home', 'basvuru', 'takip', 'site-only', 'panel'];

async function cached(name, url, headers = {}) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, name);
  if (!existsSync(file)) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return readFileSync(file);
}

// ---------- 1. fresh copy of the site ----------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(SITE, OUT_SITE, { recursive: true });
rmSync(join(OUT_SITE, 'assets', 'js'), { recursive: true, force: true }); // replaced by the bundles below
mkdirSync(OFF, { recursive: true });

// ---------- 2. page bundles: classic scripts (file:// can't load ES modules) ----------

await build({
  entryPoints: Object.fromEntries(ENTRIES.map((e) => [e, join(SITE, 'assets', 'js', `${e}.js`)])),
  outdir: OFF,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome100', 'edge100', 'firefox100', 'safari15'],
  minify: true,
  charset: 'utf8',
  legalComments: 'eof',
  define: { __OFFLINE__: 'true' },
  inject: [join(HERE, 'shim.js')],
  loader: { '.sql': 'text' },
  logLevel: 'warning',
});

// ---------- 3. vendored runtimes ----------

const sqljs = join(HERE, 'node_modules', 'sql.js', 'dist');
cpSync(join(sqljs, 'sql-wasm.js'), join(OFF, 'sqljs.js'));
const wasm = readFileSync(join(sqljs, 'sql-wasm.wasm'));
writeFileSync(join(OFF, 'sqlwasm.js'), `window.__SQL_WASM_B64=${JSON.stringify(wasm.toString('base64'))};\n`);

const excel = await cached('exceljs-4.4.0.min.js', EXCELJS_URL);
const sri = `sha384-${createHash('sha384').update(excel).digest('base64')}`;
if (sri !== EXCELJS_SRI) throw new Error(`ExcelJS integrity mismatch: ${sri}`);
writeFileSync(join(OFF, 'exceljs.min.js'), excel);

// Fonts embedded as data: URIs (browsers won't load font files across file:// paths).
const fontCss = (await cached('archivo.css', FONT_CSS_URL, { 'User-Agent': BROWSER_UA })).toString('utf8');
let faces = '';
for (const [, subset, body] of fontCss.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*{[^}]+})/g)) {
  if (subset !== 'latin' && subset !== 'latin-ext') continue;
  const url = body.match(/url\((https:[^)]+)\)/)[1];
  const woff2 = await cached(`archivo-${subset}.woff2`, url, { 'User-Agent': BROWSER_UA });
  faces += `/* ${subset} */\n${body.replace(url, `data:font/woff2;base64,${woff2.toString('base64')}`)}\n`;
}
if (!faces.includes('latin-ext')) throw new Error('Archivo font subsets not found');
writeFileSync(join(OFF, 'fonts.css'), `/* Archivo (SIL Open Font License 1.1) */\n${faces}`);
cpSync(join(HERE, 'offline.css'), join(OFF, 'offline.css'));
cpSync(join(HERE, 'assets', 'harita.webp'), join(OUT_SITE, 'assets', 'img', 'harita.webp'));

// ---------- 4. HTML rewritten for file:// ----------

const sprite = readFileSync(join(SITE, 'assets', 'icons.svg'), 'utf8')
  .replace('<svg xmlns="http://www.w3.org/2000/svg">', '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">')
  .replace(/<symbol id="/g, '<symbol id="i-'); // pages also use ids like "list" and "users"

for (const { file, prefix } of PAGES) {
  const path = join(OUT_SITE, file);
  let html = readFileSync(path, 'utf8');
  const must = (re, to, label) => {
    if (!re.test(html)) throw new Error(`${file}: ${label} not found`);
    html = html.replace(re, to);
  };
  // CSP 'self' doesn't fit file:// pages; nothing here talks to the network anyway.
  must(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '', 'CSP');
  html = html.replace(/\s*<link rel="preconnect"[^>]*>/g, '');
  must(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/,
    `<link rel="stylesheet" href="${prefix}assets/offline/fonts.css">\n  <link rel="stylesheet" href="${prefix}assets/offline/offline.css">`, 'font link');
  must(/<script type="module" src="(?:\.\.\/)?assets\/js\/([\w-]+)\.js"><\/script>/, (_, name) => [
    `<script src="${prefix}assets/offline/sqljs.js"></script>`,
    `<script src="${prefix}assets/offline/sqlwasm.js"></script>`,
    `<script src="${prefix}assets/offline/${name}.js"></script>`,
  ].join('\n  '), 'module script');
  html = html.split(`${prefix}assets/icons.svg#`).join('#i-');
  must(/<body([^>]*)>/, (m) => `${m}\n${sprite}`, 'body');
  // folder links show a directory listing on file://
  html = html.replace(/href="\.\/"/g, 'href="index.html"').replace(/href="\.\/#/g, 'href="index.html#')
    .replace(/href="panel\/"/g, 'href="panel/index.html"').replace(/href="\.\.\/"/g, 'href="../index.html"');
  if (file === 'index.html') {
    must(/<iframe title="Okulun haritadaki konumu"[^>]*><\/iframe>/,
      '<img class="map__img" src="assets/img/harita.webp" alt="Okulun haritadaki konumu: Zeytinoğlu Caddesi, Karanfilköy ve Anafartalar Okulu durakları" width="1160" height="760">', 'map iframe');
  }
  writeFileSync(path, html);
}

// ---------- 5. launchers + notes ----------

const launcher = (title, target) => `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><title>${title}</title>
<meta http-equiv="refresh" content="0; url=${target}"></head>
<body style="font-family:system-ui,sans-serif;padding:24px"><a href="${target}">${title}</a></body></html>
`;
writeFileSync(join(OUT, '1-Tanitim-sitesini-ac.html'), launcher('Tanıtım sitesini aç', 'site/index.html'));
writeFileSync(join(OUT, '2-Rehberlik-panelini-ac.html'), launcher('Rehberlik panelini aç', 'site/panel/index.html'));
const today = new Date().toISOString().slice(0, 10);
writeFileSync(join(OUT, 'BENI-OKU.txt'), `﻿İTÜ MTAL · Okul Tanıtım Ziyareti — çevrimdışı tanıtım sürümü (${today})\r
\r
İnternet gerekmez. Klasörü masaüstüne ya da bir USB belleğe kopyalayıp açın.\r
\r
  1-Tanitim-sitesini-ac.html    → tanıtım sitesi ve başvuru formu\r
  2-Rehberlik-panelini-ac.html  → rehberlik paneli\r
\r
Panel girişi:  kullanıcı adı  gulnihal   şifre  tanitim2026\r
               (yönetici: admin / tanitim2026)\r
\r
Bilmeniz gerekenler\r
- Bu sürüm gösterim içindir. Örnek okullar ve başvurular hazır gelir.\r
- Yapılan başvurular ve değişiklikler yalnızca bu bilgisayarın tarayıcısında saklanır;\r
  gerçek siteye gitmez. Sayfanın üstündeki "Örnek verilere dön" her şeyi başa alır.\r
- Google Chrome veya Microsoft Edge ile açın.\r
- Haritadaki rota düğmeleri ve WhatsApp/e-posta düğmeleri internet ister.\r
\r
Gerçek site: https://cafu1107.github.io/itumtal/\r
Kaynak kod:  https://github.com/Cafu1107/itumtal (GPL-3.0)\r
`);

// ---------- 6. zip (Windows) ----------

const zip = join(HERE, 'dist', `${NAME}.zip`);
rmSync(zip, { force: true });
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${OUT}' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });
}
console.log(`Hazır: ${OUT}${existsSync(zip) ? `\n       ${zip}` : ''}`);
