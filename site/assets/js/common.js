// Shared helpers for every page (ES module).

// true only in the offline demo build (offline/build.mjs passes --define:__OFFLINE__=true).
export const OFFLINE = typeof __OFFLINE__ !== 'undefined' && __OFFLINE__ === true;
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
export const API_BASE = OFFLINE ? 'https://offline.itumtal.invalid'
  : LOCAL ? 'http://127.0.0.1:8787' : 'https://itumtal-api.pota-proxy.workers.dev';
// Cloudflare Turnstile site key (public). Locally: Cloudflare's always-pass test key. Empty = no check.
export const TURNSTILE_SITEKEY = OFFLINE ? '' : LOCAL ? '1x00000000000000000000AA' : '';
/** The public address, used in ready-made messages (also in the offline demo). */
export const PUBLIC_SITE = 'https://cafu1107.github.io/itumtal/';
/** Accounts of the offline demo (data lives only in that browser). */
export const OFFLINE_DEMO = { user: 'gulnihal', admin: 'admin', password: 'tanitim2026' };

/** Site root: pages live at the root or in panel/. */
const ROOT = new URL(location.pathname.includes('/panel/') ? '../' : './', location.href);
export const asset = (p) => new URL(p, ROOT).href;

export class ApiError extends Error {
  constructor(status, data) {
    super((data && data.error) || 'Bağlantı kurulamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.');
    this.status = status;
    this.data = data || {};
  }
}

export async function api(path, { method = 'GET', body, token, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, null);
  }
  if (raw && res.ok) return res;
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ---------- DOM ----------

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function icon(name, cls = '') {
  // The offline build inlines the sprite into every page (file:// can't reference another file's SVG),
  // with an "i-" prefix so symbol ids can't collide with page ids like #list or #users.
  return `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="${OFFLINE ? '#i-' : `${asset('assets/icons.svg')}#`}${name}"></use></svg>`;
}

// ---------- dates (all dates are Istanbul calendar days) ----------

export const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
export const DAYS = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
export const DAYS_SHORT = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

export const parseISO = (iso) => { const [y, m, d] = iso.split('-').map(Number); return { y, m, d }; };
export const toISO = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const isoWeekday = (iso) => { const w = new Date(iso + 'T00:00:00Z').getUTCDay(); return w === 0 ? 7 : w; };
export const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const todayTR = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
export const mondayOf = (iso) => addDays(iso, 1 - isoWeekday(iso));

/** Same rule as worker/src/lib.mjs isVisitDay: weekday + start date + every-N-weeks rhythm. */
export function isVisitDay(iso, s) {
  if (!s.weekdays.includes(isoWeekday(iso))) return false;
  if (s.start_date && iso < s.start_date) return false;
  const every = s.week_interval || 1;
  if (every > 1 && s.start_date && Math.round(daysBetween(mondayOf(s.start_date), mondayOf(iso)) / 7) % every !== 0) return false;
  return true;
}

const EVERY = { 2: 'İki haftada bir', 3: 'Üç haftada bir', 4: 'Dört haftada bir' };

/** "İki haftada bir salı", "Her salı ve perşembe", "Hafta içi her gün" */
export function rhythmText(s) {
  const days = [...s.weekdays].sort();
  if (!days.length) return 'Ziyaret günleri duyurulacak';
  const names = days.map((d) => DAYS[d - 1].toLocaleLowerCase('tr'));
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} ve ${names.at(-1)}` : names[0];
  if ((s.week_interval || 1) > 1) return `${EVERY[s.week_interval]} ${list}`;
  if (days.join() === '1,2,3,4,5') return 'Hafta içi her gün';
  return `Her ${list}`;
}

/** Next `n` visit days on or after `from` (ignores closed days). */
export function nextVisitDays(s, from, n = 6) {
  const out = [];
  for (let d = from, guard = 0; out.length < n && guard < 800; d = addDays(d, 1), guard++) if (isVisitDay(d, s)) out.push(d);
  return out;
}

/** "14 Ekim Salı" / with year: "14 Ekim 2026 Salı" */
export function fmtDate(iso, { year = false, weekday = true } = {}) {
  if (!iso) return '';
  const { y, m, d } = parseISO(iso);
  let s = `${d} ${MONTHS[m - 1]}`;
  if (year) s += ` ${y}`;
  if (weekday) s += ` ${DAYS[isoWeekday(iso) - 1]}`;
  return s;
}

export function fmtDateTime(isoTs) {
  const d = new Date(isoTs);
  const local = new Date(d.getTime() + 3 * 3600000).toISOString();
  return `${fmtDate(local.slice(0, 10), { weekday: false })} ${local.slice(11, 16)}`;
}

export function relTime(isoTs) {
  const diff = (Date.now() - Date.parse(isoTs)) / 1000;
  if (diff < 60) return 'az önce';
  if (diff < 3600) return `${Math.floor(diff / 60)} dk önce`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} sa önce`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} gün önce`;
  return fmtDateTime(isoTs).replace(/ \d\d:\d\d$/, '');
}

export function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length !== 11) return p || '';
  return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7, 9)} ${d.slice(9)}`;
}

export const STATUS = {
  pending: { label: 'Bekliyor', long: 'Değerlendiriliyor' },
  approved: { label: 'Onaylandı', long: 'Ziyaretiniz onaylandı' },
  rejected: { label: 'Reddedildi', long: 'Başvurunuz kabul edilemedi' },
  cancelled: { label: 'İptal', long: 'Başvuru iptal edildi' },
};
export const pill = (status) => `<span class="pill pill--${status}">${STATUS[status]?.label || status}</span>`;

// ---------- feedback ----------

let toastRoot;
export function toast(message, { type = 'ok', ms = 3200 } = {}) {
  if (!toastRoot) {
    toastRoot = document.createElement('div');
    toastRoot.className = 'toasts';
    toastRoot.setAttribute('role', 'status');
    toastRoot.setAttribute('aria-live', 'polite');
    document.body.append(toastRoot);
  }
  const el = document.createElement('div');
  el.className = `toast${type === 'bad' ? ' toast--bad' : ''}`;
  el.innerHTML = `${icon(type === 'bad' ? 'alert' : 'check')}<span>${esc(message)}</span>`;
  toastRoot.append(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }, ms);
}

/** Promise<boolean> confirm built on <dialog>. */
export function confirmDialog({ title, text = '', ok = 'Onayla', cancel = 'Vazgeç', danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    d.innerHTML = `
      <form method="dialog">
        <div class="modal__body">
          <h2 class="modal__title">${esc(title)}</h2>
          ${text ? `<p class="modal__text">${esc(text)}</p>` : ''}
        </div>
        <div class="modal__actions">
          <button class="btn" value="no">${esc(cancel)}</button>
          <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" value="yes">${esc(ok)}</button>
        </div>
      </form>`;
    document.body.append(d);
    d.addEventListener('close', () => { resolve(d.returnValue === 'yes'); d.remove(); });
    d.showModal();
    d.querySelector('[value="yes"]').focus();
  });
}

export function setLoading(btn, on) {
  btn.classList.toggle('is-loading', on);
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Shows per-field errors returned by the API ({ fields: { name: message } }). */
export function showFieldErrors(form, fields = {}) {
  let first = null;
  for (const el of $$('[data-error-for]', form)) {
    const name = el.dataset.errorFor;
    const msg = fields[name] || '';
    el.innerHTML = msg ? `${icon('alert')}<span>${esc(msg)}</span>` : '';
    const control = form.querySelector(`[name="${name}"]`) || form.querySelector(`[data-control-for="${name}"]`);
    if (control) control.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg && !first) first = control || el;
  }
  return first;
}

// ---------- Turnstile (bot check) ----------

let turnstileReady;
function loadTurnstile() {
  turnstileReady ||= new Promise((resolve, reject) => {
    window.onTurnstileLoad = () => resolve(window.turnstile);
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad';
    s.async = true;
    s.onerror = () => { turnstileReady = null; reject(new Error('Robot doğrulaması yüklenemedi. Sayfayı yenileyin.')); };
    document.head.append(s);
  });
  return turnstileReady;
}

/**
 * Mounts an invisible-unless-needed Turnstile widget in `el`.
 * Returns { token(): Promise<string>, reset() }; token() resolves '' when Turnstile is off.
 */
export function bindTurnstile(el) {
  if (!TURNSTILE_SITEKEY) return { token: async () => '', reset() {}, remove() {} };
  let current = '';
  let waiters = [];
  let id = null;
  const settle = (t) => { current = t; waiters.forEach((w) => w(t)); waiters = []; };
  const ready = loadTurnstile().then((ts) => {
    id = ts.render(el, {
      sitekey: TURNSTILE_SITEKEY,
      language: 'tr',
      appearance: 'interaction-only',
      callback: (t) => settle(t),
      'expired-callback': () => { current = ''; },
      'error-callback': () => { current = ''; },
    });
    return ts;
  });
  return {
    async token() {
      await ready;
      if (current) return current;
      // wait for the (usually invisible) challenge to finish, at most 20 s
      return new Promise((resolve, reject) => {
        waiters.push(resolve);
        setTimeout(() => reject(new Error('Robot doğrulaması tamamlanmadı. Formun altındaki kutucuğu işaretleyip tekrar deneyin.')), 20000);
      });
    },
    reset() {
      current = '';
      ready.then((ts) => { if (id !== null) ts.reset(id); }).catch(() => {});
    },
    /** Call before the widget's element leaves the page. */
    remove() {
      ready.then((ts) => { if (id !== null) ts.remove(id); id = null; }).catch(() => {});
    },
  };
}

// Saved tracking links (this browser only) so a teacher can find their application again.
const SAVED_KEY = 'itumtal.basvurular';
export function savedApplications() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch { return []; }
}
export function saveApplication(entry) {
  try {
    const list = savedApplications().filter((e) => e.token !== entry.token);
    list.unshift(entry);
    localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 10)));
  } catch { /* storage unavailable */ }
}
