import { api, $, $$, rhythmText, fmtDate, todayTR } from './common.js';
import { initHeader, initReveal } from './site.js';

initHeader();
initReveal();

function visitDaysText(cfg) {
  let text = rhythmText(cfg);
  if (cfg.start_date && cfg.start_date > todayTR()) text += ` · ${fmtDate(cfg.start_date, { year: true, weekday: false })} itibarıyla`;
  return text;
}

// Keep the visit facts in step with the panel settings; the HTML holds sensible defaults.
api('/api/config').then((cfg) => {
  $$('[data-capacity]').forEach((el) => { el.textContent = cfg.daily_capacity; });
  $$('[data-weekdays]').forEach((el) => { el.textContent = visitDaysText(cfg); });
}).catch(() => { /* static defaults stay */ });

// ---------- Nasıl gelirim? (Google Maps transit directions, no API key needed) ----------

const SCHOOL = '41.088568,29.026529';
const routeUrl = (origin) => `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${SCHOOL}&travelmode=transit`;

function routeError(msg) {
  const el = $('#route-error');
  el.innerHTML = msg ? `<span>${msg}</span>` : '';
  $('#route-from').setAttribute('aria-invalid', msg ? 'true' : 'false');
}

$('#route-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  let from = $('#route-from').value.trim();
  if (from.length < 3) { routeError('Nereden geleceğinizi yazın.'); $('#route-from').focus(); return; }
  routeError('');
  // Helps Google pick the right place for short names like "Atatürk Ortaokulu"
  if (!/istanbul|İstanbul/i.test(from)) from += ', İstanbul';
  window.open(routeUrl(from), '_blank', 'noopener');
});
$('#route-from')?.addEventListener('input', () => routeError(''));

$('#route-here')?.addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (!('geolocation' in navigator)) { routeError('Tarayıcınız konum paylaşmayı desteklemiyor; adresinizi yazın.'); return; }
  btn.disabled = true;
  // Open the tab now: browsers block pop-ups opened after an async callback.
  const tab = window.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  navigator.geolocation.getCurrentPosition((pos) => {
    btn.disabled = false;
    const url = routeUrl(`${pos.coords.latitude.toFixed(6)},${pos.coords.longitude.toFixed(6)}`);
    if (tab) tab.location.href = url; else location.href = url;
  }, () => {
    btn.disabled = false;
    tab?.close();
    routeError('Konumunuza erişilemedi. Adresinizi ya da okulunuzun adını yazabilirsiniz.');
  }, { timeout: 10000, maximumAge: 300000 });
});
