// Rehberlik paneli — single-page app over /api/admin/*.
import {
  api, $, $$, esc, icon, asset, fmtDate, fmtDateTime, relTime, fmtPhone, pill, STATUS, MONTHS, DAYS_SHORT,
  parseISO, toISO, isoWeekday, addDays, todayTR, toast, confirmDialog, setLoading, copyText, showFieldErrors,
  bindTurnstile,
} from './common.js';

const TOKEN_KEY = 'itumtal.panel.token';
const app = $('#app');

const S = {
  token: null,
  user: null,
  apps: [],
  settings: null,
  closed: [],
  blocked: [],
  today: todayTR(),
  view: null,
  filter: 'pending',
  q: '',
  month: null,
  selDay: null,
  openId: null,
  lastFocus: null,
};

// ---------- auth ----------

function readToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
function writeToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }

async function authed(path, opts = {}) {
  try {
    return await api(path, { ...opts, token: S.token });
  } catch (err) {
    if (err.status === 401) { endSession(err.message); }
    throw err;
  }
}

function endSession(message) {
  S.token = null;
  S.user = null;
  writeToken(null);
  clearInterval(pollTimer);
  renderLogin(message);
}

async function boot() {
  S.token = readToken();
  if (!S.token) return renderLogin();
  try {
    const { user } = await api('/api/auth/me', { token: S.token });
    S.user = user;
    start();
  } catch (err) {
    if (err.status === 401) endSession();
    else renderLogin(err.message);
  }
}

function renderLogin(message = '') {
  document.title = 'Giriş · Rehberlik Paneli · İTÜ MTAL';
  app.innerHTML = `
    <div class="login">
      <div class="login__art" aria-hidden="true">
        <img src="${asset('assets/img/avlu-1200.webp')}" alt="">
        <div class="login__quote"><b>Tanıtım ziyaretleri paneli</b><span>İTÜ Mesleki ve Teknik Anadolu Lisesi · Rehberlik servisi</span></div>
      </div>
      <div class="login__side">
        <div class="login__card">
          <img src="${asset('assets/img/logo.webp')}" alt="İTÜ MTAL logosu">
          <h1>Panele giriş</h1>
          <p>Ziyaret başvurularını yönetmek için giriş yapın.</p>
          <form id="login" novalidate>
            <div class="callout callout--bad" id="login-error" role="alert" ${message ? '' : 'hidden'}>${icon('alert')}<span>${esc(message)}</span></div>
            <div class="field">
              <label class="label" for="username">Kullanıcı adı</label>
              <input class="input" id="username" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" required>
            </div>
            <div class="field">
              <label class="label" for="password">Şifre</label>
              <div class="pw">
                <input class="input" id="password" name="password" type="password" autocomplete="current-password" required>
                <button class="icon-btn" type="button" id="pw-toggle" aria-label="Şifreyi göster" aria-pressed="false">${icon('eye')}</button>
              </div>
            </div>
            <div class="turnstile" id="turnstile"></div>
            <button class="btn btn--primary btn--lg btn--block" type="submit">Giriş yap</button>
          </form>
          <p class="login__foot"><a href="../">← Siteye dön</a></p>
        </div>
      </div>
    </div>`;
  const form = $('#login');
  const human = bindTurnstile($('#turnstile'));
  $('#username').focus();
  $('#pw-toggle').addEventListener('click', (e) => {
    const pw = $('#password');
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-pressed', String(show));
    e.currentTarget.setAttribute('aria-label', show ? 'Şifreyi gizle' : 'Şifreyi göster');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = form.username.value.trim();
    const password = form.password.value;
    const errBox = $('#login-error');
    if (!username || !password) {
      errBox.hidden = false;
      errBox.querySelector('span').textContent = 'Kullanıcı adı ve şifreyi yazın.';
      return;
    }
    const btn = form.querySelector('[type="submit"]');
    setLoading(btn, true);
    try {
      const turnstile = await human.token();
      const res = await api('/api/auth/login', { method: 'POST', body: { username, password, turnstile } });
      S.token = res.token;
      S.user = res.user;
      writeToken(res.token);
      start();
    } catch (err) {
      setLoading(btn, false);
      errBox.hidden = false;
      errBox.querySelector('span').textContent = err.message;
      human.reset();
      form.password.select();
    }
  });
}

// ---------- shell ----------

let pollTimer;

async function start() {
  renderShell();
  try {
    await Promise.all([loadApps(), loadSettings(), loadBlocked()]);
  } catch (err) {
    if (err.status !== 401) toast(err.message, { type: 'bad' });
    if (!S.token) return;
  }
  route();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && S.token) loadApps().then(refreshView).catch(() => {});
  }, 60000);
}

const NAV = [
  { id: 'basvurular', label: 'Başvurular', icon: 'inbox' },
  { id: 'takvim', label: 'Takvim', icon: 'calendar' },
  { id: 'ayarlar', label: 'Ayarlar', icon: 'sliders' },
];

function renderShell() {
  const initial = (S.user.display_name || S.user.username).trim().charAt(0).toLocaleUpperCase('tr');
  const brand = `<a class="brand" href="#/basvurular"><img src="${asset('assets/img/logo.webp')}" alt="" width="40" height="40"><span class="brand__text"><span class="brand__name">İTÜ MTAL</span><span class="brand__sub">Rehberlik paneli</span></span></a>`;
  app.innerHTML = `
    <div class="shell" id="shell">
      <aside class="sidebar">
        ${brand}
        <nav class="sidenav" aria-label="Panel menüsü">
          ${NAV.map((n) => `<a href="#/${n.id}" data-nav="${n.id}">${icon(n.icon)}${n.label}${n.id === 'basvurular' ? '<span class="count-badge" data-pending></span>' : ''}</a>`).join('')}
        </nav>
        <div class="sidebar__user">
          <span class="avatar" aria-hidden="true">${esc(initial)}</span>
          <div><b>${esc(S.user.display_name)}</b><small>${S.user.role === 'admin' ? 'Yönetici' : 'Rehberlik'}</small></div>
          <button class="icon-btn" type="button" data-logout aria-label="Çıkış yap" title="Çıkış yap">${icon('log-out')}</button>
        </div>
      </aside>
      <header class="topbar">
        ${brand}
        <button class="icon-btn" type="button" data-logout aria-label="Çıkış yap">${icon('log-out')}</button>
      </header>
      <main class="main" id="view" tabindex="-1"></main>
      <nav class="tabbar" aria-label="Panel menüsü">
        ${NAV.map((n) => `<a href="#/${n.id}" data-nav="${n.id}">${icon(n.icon)}${n.label}${n.id === 'basvurular' ? '<span class="count-badge" data-pending></span>' : ''}</a>`).join('')}
      </nav>
    </div>
    <div class="scrim" id="scrim" hidden></div>
    <aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" hidden></aside>`;
  $$('[data-logout]').forEach((b) => b.addEventListener('click', logout));
  $('#scrim').addEventListener('click', closeDrawer);
}

async function logout() {
  const ok = await confirmDialog({ title: 'Çıkış yapılsın mı?', ok: 'Çıkış yap' });
  if (!ok) return;
  try { await api('/api/auth/logout', { method: 'POST', token: S.token }); } catch { /* already gone */ }
  endSession();
}

function updateBadges() {
  const n = S.apps.filter((a) => a.status === 'pending').length;
  $$('[data-pending]').forEach((el) => { el.textContent = n ? String(n) : ''; });
  document.title = `${n ? `(${n}) ` : ''}Rehberlik Paneli · İTÜ MTAL`;
}

// ---------- data ----------

async function loadApps() {
  const res = await authed('/api/admin/applications');
  S.apps = res.applications;
  S.today = res.today;
  updateBadges();
}

async function loadSettings() {
  const res = await authed('/api/admin/settings');
  S.settings = res.settings;
  S.closed = res.closed_days;
}

async function loadBlocked() {
  const res = await authed('/api/admin/blocked-ips');
  S.blocked = res.blocked;
}

const isBlocked = (ip) => !!ip && S.blocked.some((b) => b.ip === ip);

const closedMap = () => new Map(S.closed.map((c) => [c.date, c.reason]));

/** Approved students per date, optionally ignoring one application. */
function usedOn(date, exceptId = 0) {
  let n = 0;
  for (const a of S.apps) if (a.status === 'approved' && a.visit_date === date && a.id !== exceptId) n += a.student_count;
  return n;
}

function upsertApp(a) {
  const i = S.apps.findIndex((x) => x.id === a.id);
  const merged = { ...(i >= 0 ? S.apps[i] : {}), ...a };
  if (i >= 0) S.apps[i] = merged; else S.apps.unshift(merged);
  updateBadges();
  return merged;
}

// ---------- routing ----------

window.addEventListener('hashchange', route);

function route() {
  if (!S.user) return;
  const [, view = 'basvurular', id] = (location.hash || '#/basvurular').split('/');
  const v = NAV.some((n) => n.id === view) ? view : 'basvurular';
  if (v !== S.view) {
    S.view = v;
    $$('[data-nav]').forEach((a) => a.toggleAttribute('aria-current', a.dataset.nav === v));
    $$('[data-nav][aria-current]').forEach((a) => a.setAttribute('aria-current', 'page'));
    refreshView();
    $('#view').scrollTo?.(0, 0);
    window.scrollTo(0, 0);
  }
  const wanted = id ? Number(id) : null;
  if (wanted && wanted !== S.openId) openDrawer(wanted);
  if (!wanted && S.openId) hideDrawer();
}

function go(view, id) {
  location.hash = id ? `#/${view}/${id}` : `#/${view}`;
}

function refreshView() {
  if (S.view === 'basvurular') renderApps();
  else if (S.view === 'takvim') renderCalendar();
  else if (S.view === 'ayarlar') renderSettings();
}

// ---------- applications view ----------

const FILTERS = [
  { id: 'pending', label: 'Bekleyen' },
  { id: 'approved', label: 'Onaylı' },
  { id: 'rejected', label: 'Reddedilen' },
  { id: 'cancelled', label: 'İptal' },
  { id: 'all', label: 'Tümü' },
];

const fold = (s) => String(s || '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/\p{M}/gu, '');

function filtered() {
  const q = fold(S.q).trim();
  let list = S.apps.filter((a) => S.filter === 'all' || a.status === S.filter);
  if (q) {
    const qDigits = q.replace(/\D/g, '');
    list = list.filter((a) => fold(`${a.school_name} ${a.teacher_name} ${a.district} ${a.code} ${a.email} ${a.ip || ''}`).includes(q)
      || (qDigits.length >= 3 && a.phone.includes(qDigits)));
  }
  const by = (k, dir = 1) => (x, y) => (x[k] < y[k] ? -dir : x[k] > y[k] ? dir : 0);
  if (S.filter === 'pending') list.sort(by('created_at'));
  else if (S.filter === 'approved') {
    const key = (a) => `${a.visit_date} ${a.visit_time}`;
    const up = list.filter((a) => a.visit_date >= S.today).sort((x, y) => key(x).localeCompare(key(y)));
    const past = list.filter((a) => a.visit_date < S.today).sort((x, y) => key(y).localeCompare(key(x)));
    list = [...up, ...past];
  } else if (S.filter === 'all') list.sort(by('created_at', -1));
  else list.sort(by('updated_at', -1));
  return list;
}

function renderApps() {
  const pending = S.apps.filter((a) => a.status === 'pending').length;
  const upcoming = S.apps.filter((a) => a.status === 'approved' && a.visit_date >= S.today);
  const upStudents = upcoming.reduce((n, a) => n + a.student_count, 0);
  $('#view').innerHTML = `
    <div class="view-head">
      <div>
        <h1>Başvurular</h1>
        <p>${pending ? `<b>${pending}</b> başvuru yanıt bekliyor` : 'Bekleyen başvuru yok'} · ${upcoming.length} yaklaşan ziyaret (${upStudents} öğrenci)</p>
      </div>
      <div class="view-head__actions">
        <button class="btn btn--sm" type="button" id="refresh">${icon('refresh')}Yenile</button>
        <button class="btn btn--sm" type="button" id="export">${icon('download')}Excel (CSV)</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="Duruma göre filtrele">
        ${FILTERS.map((f) => {
          const n = f.id === 'all' ? S.apps.length : S.apps.filter((a) => a.status === f.id).length;
          return `<button type="button" role="tab" data-filter="${f.id}" aria-selected="${S.filter === f.id}">${f.label}<span class="n">${n}</span></button>`;
        }).join('')}
      </div>
      <label class="search">
        <span class="visually-hidden">Ara</span>
        ${icon('search')}
        <input class="input" type="search" id="q" placeholder="Okul, öğretmen, kod, telefon veya IP" value="${esc(S.q)}" autocomplete="off">
      </label>
    </div>
    <div id="list"></div>`;
  renderList();

  $$('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    S.filter = b.dataset.filter;
    $$('[data-filter]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    renderList();
  }));
  $('#q').addEventListener('input', (e) => { S.q = e.target.value; renderList(); });
  $('#refresh').addEventListener('click', async (e) => {
    setLoading(e.currentTarget, true);
    try { await loadApps(); renderApps(); toast('Liste güncellendi.'); } catch (err) { toast(err.message, { type: 'bad' }); }
    finally { setLoading(e.currentTarget, false); }
  });
  $('#export').addEventListener('click', exportCSV);
}

function shortDate(iso) {
  const { d, m } = parseISO(iso);
  return `${d} ${MONTHS[m - 1].slice(0, 3)} ${DAYS_SHORT[isoWeekday(iso) - 1]}`;
}

function renderList() {
  const list = filtered();
  const box = $('#list');
  if (!list.length) {
    const msg = S.q ? 'Aramanızla eşleşen başvuru yok.' : {
      pending: 'Yanıt bekleyen başvuru yok.', approved: 'Onaylanmış ziyaret yok.', rejected: 'Reddedilen başvuru yok.',
      cancelled: 'İptal edilen başvuru yok.', all: 'Henüz başvuru gelmedi.',
    }[S.filter];
    box.innerHTML = `<div class="list"><div class="empty">${icon('inbox')}<b>${msg}</b>${S.filter === 'pending' && !S.q ? 'Yeni başvurular geldiğinde burada görünür.' : ''}</div></div>`;
    return;
  }
  box.innerHTML = `<div class="list" role="list">
    <div class="row row--head" aria-hidden="true"><span>Okul</span><span class="col-teacher">Öğretmen</span><span>Öğr.</span><span>${S.filter === 'approved' ? 'Ziyaret' : 'Tercih / ziyaret'}</span><span class="col-time">Başvuru</span><span>Durum</span></div>
    ${list.map((a) => {
      const past = a.status === 'approved' && a.visit_date < S.today;
      const dates = a.status === 'approved'
        ? `<span class="when">${icon('calendar')}${shortDate(a.visit_date)} · ${esc(a.visit_time)}</span>`
        : a.preferred_dates.map((d, i) => `<span>${i + 1}. <b>${shortDate(d)}</b></span>`).join('<br>');
      return `<button type="button" class="row${past ? ' is-past' : ''}${S.openId === a.id ? ' is-active' : ''}" role="listitem" data-id="${a.id}">
        <span class="col-main cell-main"><b>${esc(a.school_name)}</b><small>${esc(a.district)} · <span class="mono">${esc(a.code)}</span></small></span>
        <span class="col-teacher"><span class="cell-sub" style="color:var(--ink);font-weight:600">${esc(a.teacher_name)}</span><span class="cell-sub">${esc(fmtPhone(a.phone))}</span></span>
        <span class="col-n cell-n">${a.student_count}</span>
        <span class="col-dates cell-dates">${dates}</span>
        <span class="col-time cell-time">${esc(relTime(a.created_at))}</span>
        <span class="col-status">${pill(a.status)}</span>
      </button>`;
    }).join('')}
  </div>`;
  $$('.row[data-id]', box).forEach((r) => r.addEventListener('click', () => go(S.view, r.dataset.id)));
}

async function exportCSV(e) {
  const btn = e.currentTarget;
  setLoading(btn, true);
  try {
    const res = await api('/api/admin/export.csv', { token: S.token, raw: true });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ziyaret-basvurulari-${S.today}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    if (err.status === 401) endSession(err.message);
    else toast(err.message, { type: 'bad' });
  } finally {
    setLoading(btn, false);
  }
}

// ---------- drawer ----------

function trackLink(a) {
  return new URL(`../takip.html?t=${a.token}`, location.href).href;
}

function waLink(a) {
  if (!/^05\d{9}$/.test(a.phone)) return null;
  const who = S.user.display_name;
  const text = a.status === 'approved'
    ? `Merhaba ${a.teacher_name} Hocam, İTÜ Mesleki ve Teknik Anadolu Lisesi rehberlik servisinden ${who}. ${a.school_name} için tanıtım ziyaretiniz ${fmtDate(a.visit_date)} saat ${a.visit_time} olarak planlandı. Ayrıntıları buradan görebilirsiniz: ${trackLink(a)}`
    : `Merhaba ${a.teacher_name} Hocam, İTÜ Mesleki ve Teknik Anadolu Lisesi rehberlik servisinden ${who}. ${a.school_name} için yaptığınız tanıtım ziyareti başvurusu (${a.code}) hakkında yazıyorum.`;
  return `https://wa.me/9${a.phone}?text=${encodeURIComponent(text)}`;
}

function mailLink(a) {
  const subject = `İTÜ MTAL tanıtım ziyareti (${a.code})`;
  return `mailto:${a.email}?subject=${encodeURIComponent(subject)}`;
}

async function openDrawer(id) {
  const a = S.apps.find((x) => x.id === id);
  if (!a) {
    try { await loadApps(); } catch { /* handled */ }
    if (!S.apps.some((x) => x.id === id)) { toast('Başvuru bulunamadı.', { type: 'bad' }); go(S.view); return; }
  }
  if (!S.openId) S.lastFocus = document.activeElement;
  S.openId = id;
  const drawer = $('#drawer');
  const scrim = $('#scrim');
  drawer.hidden = false;
  scrim.hidden = false;
  $('#shell').inert = true;
  requestAnimationFrame(() => { drawer.classList.add('is-open'); scrim.classList.add('is-open'); });
  $$('.row.is-active').forEach((r) => r.classList.remove('is-active'));
  $(`.row[data-id="${id}"]`)?.classList.add('is-active');
  renderDrawer(S.apps.find((x) => x.id === id), null);
  $('#drawer-close')?.focus();
  try {
    const res = await authed(`/api/admin/applications/${id}`);
    if (S.openId !== id) return;
    const merged = upsertApp(res.application);
    renderDrawer(merged, res.events, { keepScroll: true });
  } catch (err) {
    if (err.status === 404) { toast('Bu başvuru silinmiş.', { type: 'bad' }); go(S.view); }
  }
}

function closeDrawer() { go(S.view); }

function hideDrawer() {
  const drawer = $('#drawer');
  const scrim = $('#scrim');
  S.openId = null;
  drawer.classList.remove('is-open');
  scrim.classList.remove('is-open');
  $('#shell').inert = false;
  $$('.row.is-active').forEach((r) => r.classList.remove('is-active'));
  const done = () => { if (!S.openId) { drawer.hidden = true; scrim.hidden = true; drawer.innerHTML = ''; } };
  drawer.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 400);
  if (S.lastFocus && document.contains(S.lastFocus)) S.lastFocus.focus();
  else $(`.row[data-id]`)?.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.openId && !document.querySelector('dialog[open]')) closeDrawer();
});

const EVENT_TEXT = {
  created: 'Başvuru yapıldı', approved: 'Onaylandı', rescheduled: 'Tarih değiştirildi', rejected: 'Reddedildi',
  cancelled: 'İptal edildi', reopened: 'Yeniden değerlendirmeye alındı',
};

function meterHTML(used, add, cap) {
  const total = used + add;
  const pct = (n) => `${Math.min(100, (n / cap) * 100)}%`;
  return `<div class="meter${total > cap ? ' is-over' : ''}">
    <div class="meter__bar"><span class="meter__fill" style="width:${pct(used)}"></span>${add ? `<span class="meter__add" style="left:${pct(used)};width:calc(${pct(total)} - ${pct(used)})"></span>` : ''}</div>
    <span class="meter__label">${total}/${cap}</span>
  </div>`;
}

function dayWarning(date) {
  const closed = closedMap();
  if (closed.has(date)) return `Bu gün ziyarete kapalı olarak işaretli${closed.get(date) ? ` (${closed.get(date)})` : ''}.`;
  if (!S.settings.weekdays.includes(isoWeekday(date))) return 'Bu gün normalde ziyaret kabul edilen günlerden değil.';
  if (date < S.today) return 'Bu tarih geçmişte kaldı.';
  return '';
}

function planForm(a) {
  const prefs = a.preferred_dates;
  const current = a.status === 'approved' ? a.visit_date : (prefs.find((d) => !dayWarning(d)) || prefs[0]);
  const isOther = !prefs.includes(current);
  return `
    <form class="plan" id="plan" novalidate>
      <fieldset class="field" style="border:0;padding:0;margin:0">
        <legend class="label" style="padding:0;margin-bottom:6px">Ziyaret günü</legend>
        <div class="seg">
          ${prefs.map((d, i) => `<input type="radio" name="pick" id="pk${i}" value="${d}" ${d === current ? 'checked' : ''}><label for="pk${i}">${i + 1}. ${shortDate(d)}</label>`).join('')}
          <input type="radio" name="pick" id="pk-other" value="other" ${isOther ? 'checked' : ''}><label for="pk-other">Başka gün</label>
        </div>
      </fieldset>
      <div class="plan__row">
        <div class="field">
          <label class="label" for="visit_date">Tarih</label>
          <input class="input" type="date" id="visit_date" name="visit_date" value="${esc(current || '')}" ${isOther ? '' : 'readonly'}>
          <p class="error-text" data-error-for="visit_date"></p>
        </div>
        <div class="field">
          <label class="label" for="visit_time">Saat</label>
          <input class="input" type="time" id="visit_time" name="visit_time" step="300" value="${esc(a.visit_time || '')}">
          <p class="error-text" data-error-for="visit_time"></p>
        </div>
      </div>
      <div class="plan__cap" id="plan-cap"></div>
      <div class="field">
        <label class="label" for="admin_message">Öğretmene not <span class="opt">(takip sayfasında görünür)</span></label>
        <textarea class="textarea" id="admin_message" name="admin_message" maxlength="600" style="min-height:84px" placeholder="Örn. Ana girişte sizi karşılayacağız.">${esc(a.admin_message || '')}</textarea>
      </div>
      <div class="btn-row">
        <button class="btn btn--ok" type="submit">${icon('check')}${a.status === 'approved' ? 'Değişikliği kaydet' : 'Ziyareti onayla'}</button>
      </div>
    </form>`;
}

function renderDrawer(a, events, { keepScroll = false } = {}) {
  const drawer = $('#drawer');
  const prevScroll = keepScroll ? $('.drawer__body', drawer)?.scrollTop : 0;
  const wa = waLink(a);
  const cap = S.settings.daily_capacity;

  let statusBlock = '';
  if (a.status === 'pending') {
    statusBlock = `
      <section class="box"><h3>Ziyareti planla</h3>${planForm(a)}</section>
      <section class="box">
        <button class="details-toggle" type="button" aria-expanded="false" aria-controls="reject-box" id="reject-toggle">Başvuruyu reddet ${icon('chevron-down')}</button>
        <div id="reject-box" hidden style="margin-top:12px;display:grid;gap:12px">
          <div class="field"><label class="label" for="reject_msg">Gerekçe <span class="opt">(takip sayfasında görünür)</span></label>
          <textarea class="textarea" id="reject_msg" maxlength="600" style="min-height:80px" placeholder="Örn. Bu dönem tanıtım takvimimiz doldu.">${esc(a.admin_message || '')}</textarea></div>
          <div class="btn-row"><button class="btn btn--danger" type="button" id="do-reject">${icon('x')}Reddet</button></div>
        </div>
      </section>`;
  } else if (a.status === 'approved') {
    statusBlock = `
      <section class="box">
        <h3>Planlanan ziyaret</h3>
        <div class="visit-box"><div>${icon('calendar')}${esc(fmtDate(a.visit_date, { year: true }))}</div><div>${icon('clock')}${esc(a.visit_time)}</div></div>
        ${a.admin_message ? `<div class="message-box" style="margin-top:12px"><small>Öğretmene not</small>${esc(a.admin_message)}</div>` : ''}
        <div class="btn-row" style="margin-top:14px">
          <button class="btn btn--sm" type="button" id="toggle-plan" aria-expanded="false">${icon('calendar')}Tarih / saat değiştir</button>
          <button class="btn btn--sm" type="button" id="do-reopen">${icon('rotate')}Beklemeye al</button>
          <button class="btn btn--sm btn--danger" type="button" id="do-cancel">${icon('ban')}Ziyareti iptal et</button>
        </div>
        <div id="plan-wrap" hidden style="margin-top:16px;padding-top:16px;border-top:1px solid var(--line)">${planForm(a)}</div>
      </section>`;
  } else {
    statusBlock = `
      <section class="box">
        <h3>${a.status === 'rejected' ? 'Reddedildi' : 'İptal edildi'}</h3>
        <p style="color:var(--ink-2)">${a.status === 'cancelled' ? (a.cancelled_by === 'teacher' ? 'Öğretmen başvurusunu takip sayfasından iptal etti.' : 'Okul tarafından iptal edildi.') : 'Bu başvuru reddedildi.'}</p>
        ${a.admin_message ? `<div class="message-box" style="margin-top:12px"><small>Öğretmene not</small>${esc(a.admin_message)}</div>` : ''}
        <div class="btn-row" style="margin-top:14px"><button class="btn btn--sm" type="button" id="do-reopen">${icon('rotate')}Yeniden değerlendir</button></div>
      </section>`;
  }

  drawer.innerHTML = `
    <div class="drawer__head">
      <div style="min-width:0">
        <h2 id="drawer-title">${esc(a.school_name)}</h2>
        <div class="drawer__meta">${pill(a.status)}<span class="mono">${esc(a.code)}</span><span>${esc(a.district)}</span><span>${esc(relTime(a.created_at))}</span></div>
      </div>
      <button class="icon-btn" type="button" id="drawer-close" aria-label="Kapat">${icon('x')}</button>
    </div>
    <div class="drawer__body">
      <section class="box">
        <div class="who"><b>${esc(a.teacher_name)}</b><p>${esc(a.teacher_role || 'Görevi belirtilmedi')} · ${esc(fmtPhone(a.phone))} · ${esc(a.email)}</p></div>
        <div class="contact-actions">
          <a class="btn" href="tel:${esc(a.phone)}">${icon('phone')}Ara</a>
          ${wa ? `<a class="btn btn--wa" href="${esc(wa)}" target="_blank" rel="noopener">${icon('message')}WhatsApp</a>` : `<span class="btn" aria-disabled="true" title="Sabit hat numarası">${icon('message')}WhatsApp</span>`}
          <a class="btn" href="${esc(mailLink(a))}">${icon('mail')}E-posta</a>
          <button class="btn" type="button" id="copy-track">${icon('link')}Takip linki</button>
        </div>
      </section>

      <dl class="kv">
        <div><dt>Öğrenci</dt><dd>${a.student_count}</dd></div>
        <div><dt>Eşlik eden öğretmen</dt><dd>${a.escort_count || '—'}</dd></div>
        <div><dt>Sınıf</dt><dd>${esc(a.grade)}</dd></div>
        <div><dt>Saat tercihi</dt><dd>${esc(a.time_pref)}</dd></div>
        <div style="grid-column:span 2"><dt>Başvuru zamanı</dt><dd>${esc(fmtDateTime(a.created_at))}</dd></div>
      </dl>

      ${a.note ? `<div class="message-box" style="background:var(--card)"><small>Öğretmenin notu</small>${esc(a.note)}</div>` : ''}

      ${statusBlock}

      <section class="box">
        <h3>Tercih edilen günler</h3>
        <ul class="prefs">
          ${a.preferred_dates.map((d, i) => {
            const used = usedOn(d, a.id);
            const warn = dayWarning(d);
            return `<li class="pref"><span class="pref__no">${i + 1}</span><div><b>${esc(fmtDate(d))}</b><small>${warn ? esc(warn) : `${Math.max(0, cap - used)} kişilik yer var`}</small></div>${meterHTML(used, a.student_count, cap)}</li>`;
          }).join('')}
        </ul>
      </section>

      <section class="box">
        <h3>İç not</h3>
        <label class="visually-hidden" for="internal_note">İç not</label>
        <textarea class="textarea" id="internal_note" maxlength="2000" style="min-height:80px" placeholder="Yalnızca panelde görünür. Örn. 11 Ekim'de arandı, saat için dönüş bekleniyor.">${esc(a.internal_note || '')}</textarea>
        <p class="saving" id="note-state" aria-live="polite"></p>
      </section>

      <section class="box">
        <h3>Geçmiş</h3>
        ${events ? `<ol class="events">${events.map((ev) => `<li><time>${esc(fmtDateTime(ev.at))}</time><span><b>${esc(EVENT_TEXT[ev.action] || ev.action)}</b> · ${esc(ev.actor)}${ev.detail ? ` · ${esc(ev.action === 'created' ? ev.detail.split(', ').map((d) => shortDate(d)).join(', ') : ev.detail)}` : ''}</span></li>`).join('')}</ol>` : '<div class="skel" style="height:60px"></div>'}
      </section>

      <section class="box">
        <h3>Güvenlik</h3>
        ${a.ip ? `<p style="color:var(--ink-2);font-size:.9375rem">IP adresi <b class="mono">${esc(a.ip)}</b> · bu adresten ${S.apps.filter((x) => x.ip === a.ip).length} başvuru${isBlocked(a.ip) ? ' · <b style="color:var(--bad)">engelli</b>' : ''}</p>
        <div class="btn-row" style="margin-top:12px">
          ${isBlocked(a.ip)
            ? `<button class="btn btn--sm" type="button" id="do-unblock">${icon('check')}Engeli kaldır</button>`
            : `<button class="btn btn--sm btn--danger" type="button" id="do-block">${icon('ban')}Bu IP'yi engelle</button>`}
          <button class="btn btn--sm btn--ghost" type="button" id="filter-ip">${icon('search')}Bu IP'nin başvuruları</button>
        </div>` : '<p class="hint">Bu başvuru IP kaydı tutulmaya başlanmadan önce yapılmış.</p>'}
      </section>

      <button class="btn btn--sm btn--ghost" type="button" id="do-delete" style="justify-self:start;color:var(--bad)">${icon('trash')}Başvuruyu kalıcı olarak sil</button>
    </div>`;

  if (keepScroll) $('.drawer__body', drawer).scrollTop = prevScroll;
  wireDrawer(a);
}

function wireDrawer(a) {
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#copy-track').addEventListener('click', async () => {
    if (await copyText(trackLink(a))) toast('Takip bağlantısı kopyalandı.');
  });

  const plan = $('#plan');
  if (plan) wirePlan(a, plan);

  $('#toggle-plan')?.addEventListener('click', (e) => {
    const wrap = $('#plan-wrap');
    wrap.hidden = !wrap.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!wrap.hidden));
    if (!wrap.hidden) $('#visit_time').focus();
  });

  $('#reject-toggle')?.addEventListener('click', (e) => {
    const box = $('#reject-box');
    box.hidden = !box.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
    if (!box.hidden) $('#reject_msg').focus();
  });

  $('#do-reject')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({ title: 'Başvuru reddedilsin mi?', text: `${a.school_name} başvurusu reddedilecek. Öğretmen durumu takip sayfasında görür.`, ok: 'Reddet', danger: true });
    if (ok) act(a, { action: 'reject', admin_message: $('#reject_msg').value }, e.currentTarget, 'Başvuru reddedildi.');
  });
  $('#do-cancel')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({ title: 'Ziyaret iptal edilsin mi?', text: `${fmtDate(a.visit_date)} ${a.visit_time} ziyareti iptal edilecek ve o günün kontenjanı boşalacak. Öğretmene haber vermeyi unutmayın.`, ok: 'İptal et', danger: true });
    if (ok) act(a, { action: 'cancel' }, e.currentTarget, 'Ziyaret iptal edildi.');
  });
  $('#do-reopen')?.addEventListener('click', (e) => act(a, { action: 'reopen' }, e.currentTarget, 'Başvuru yeniden beklemeye alındı.'));

  const note = $('#internal_note');
  let saved = note.value;
  const saveNote = async () => {
    if (note.value === saved) return;
    const val = note.value;
    $('#note-state').textContent = 'Kaydediliyor…';
    try {
      const res = await authed(`/api/admin/applications/${a.id}`, { method: 'PATCH', body: { action: 'notes', internal_note: val } });
      upsertApp(res.application);
      saved = val;
      $('#note-state').textContent = 'Kaydedildi.';
    } catch (err) {
      $('#note-state').textContent = `Kaydedilemedi: ${err.message}`;
    }
  };
  note.addEventListener('blur', saveNote);
  let t;
  note.addEventListener('input', () => { clearTimeout(t); $('#note-state').textContent = ''; t = setTimeout(saveNote, 1200); });

  $('#do-block')?.addEventListener('click', () => blockFlow(a.ip));
  $('#do-unblock')?.addEventListener('click', async () => {
    try {
      const res = await authed(`/api/admin/blocked-ips/${encodeURIComponent(a.ip)}`, { method: 'DELETE' });
      S.blocked = res.blocked;
      toast('Engel kaldırıldı.');
      renderDrawer(S.apps.find((x) => x.id === a.id) || a, null);
    } catch (err) { toast(err.message, { type: 'bad' }); }
  });
  $('#filter-ip')?.addEventListener('click', () => {
    S.filter = 'all';
    S.q = a.ip;
    S.view = null;
    go('basvurular');
  });

  $('#do-delete').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Başvuru kalıcı olarak silinsin mi?', text: 'Bu işlem geri alınamaz. Öğretmenin takip bağlantısı da çalışmaz hâle gelir.', ok: 'Sil', danger: true });
    if (!ok) return;
    try {
      await authed(`/api/admin/applications/${a.id}`, { method: 'DELETE' });
      S.apps = S.apps.filter((x) => x.id !== a.id);
      updateBadges();
      toast('Başvuru silindi.');
      closeDrawer();
      refreshView();
    } catch (err) { toast(err.message, { type: 'bad' }); }
  });
}

function wirePlan(a, plan) {
  const dateInput = $('#visit_date', plan);
  const updateCap = () => {
    const d = dateInput.value;
    const box = $('#plan-cap', plan);
    if (!d) { box.innerHTML = '<span class="hint">Bir tarih seçin.</span>'; return; }
    const used = usedOn(d, a.id);
    const cap = S.settings.daily_capacity;
    const total = used + a.student_count;
    const warn = dayWarning(d);
    const others = S.apps.filter((x) => x.status === 'approved' && x.visit_date === d && x.id !== a.id)
      .sort((x, y) => x.visit_time.localeCompare(y.visit_time));
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:8px;font-size:.875rem"><b>${esc(fmtDate(d))}</b><span>${total > cap ? `<b style="color:var(--bad)">Kontenjan ${total - cap} kişi aşılıyor</b>` : `${cap - total} kişilik yer kalır`}</span></div>
      ${meterHTML(used, a.student_count, cap)}
      ${others.length ? `<span class="hint">O gün: ${others.map((x) => `${esc(x.visit_time)} ${esc(x.school_name)} (${x.student_count})`).join(' · ')}</span>` : '<span class="hint">O gün başka ziyaret yok.</span>'}
      ${warn ? `<span class="error-text" style="color:var(--warn)">${icon('alert')}<span>${esc(warn)}</span></span>` : ''}`;
  };
  $$('input[name="pick"]', plan).forEach((r) => r.addEventListener('change', () => {
    if (r.value === 'other') {
      dateInput.readOnly = false;
      dateInput.focus();
      dateInput.showPicker?.();
    } else {
      dateInput.readOnly = true;
      dateInput.value = r.value;
    }
    updateCap();
  }));
  dateInput.addEventListener('input', () => {
    const match = $$('input[name="pick"]', plan).find((r) => r.value === dateInput.value);
    if (match) match.checked = true;
    updateCap();
  });
  updateCap();

  plan.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { action: 'approve', visit_date: dateInput.value, visit_time: $('#visit_time', plan).value, admin_message: $('#admin_message', plan).value };
    const errs = {};
    if (!body.visit_date) errs.visit_date = 'Ziyaret tarihini seçin.';
    if (!/^\d{2}:\d{2}$/.test(body.visit_time)) errs.visit_time = 'Öğretmenle kararlaştırdığınız saati girin.';
    if (Object.keys(errs).length) { showFieldErrors(plan, errs)?.focus(); return; }
    showFieldErrors(plan, {});
    const btn = plan.querySelector('[type="submit"]');
    const wasApproved = a.status === 'approved';
    await act(a, body, btn, wasApproved ? 'Ziyaret güncellendi.' : 'Ziyaret onaylandı. Öğretmene bilgi vermeyi unutmayın.', plan);
  });
}

async function act(a, body, btn, okMsg, form) {
  setLoading(btn, true);
  try {
    let res;
    try {
      res = await authed(`/api/admin/applications/${a.id}`, { method: 'PATCH', body });
    } catch (err) {
      if (err.status === 409 && err.data.code === 'capacity') {
        const { used, capacity, adding } = err.data;
        const ok = await confirmDialog({
          title: 'Kontenjan aşılacak',
          text: `${fmtDate(body.visit_date)} için onaylı ${used} öğrenci var. Bu grupla ${used + adding} olacak (günlük sınır ${capacity}). Yine de onaylansın mı?`,
          ok: 'Yine de onayla',
        });
        if (!ok) return;
        res = await authed(`/api/admin/applications/${a.id}`, { method: 'PATCH', body: { ...body, force: true } });
      } else throw err;
    }
    const merged = upsertApp(res.application);
    toast(okMsg);
    renderDrawer(merged, res.events);
    if (S.view === 'basvurular') renderApps();
    else if (S.view === 'takvim') renderCalendar();
    if (body.action === 'approve' && waLink(merged)) {
      // offer the ready-made WhatsApp message right away
      const wa = $('.btn--wa');
      wa?.classList.add('btn--signal');
    }
  } catch (err) {
    if (err.data?.fields && form) showFieldErrors(form, err.data.fields);
    toast(err.message, { type: 'bad' });
  } finally {
    if (document.contains(btn)) setLoading(btn, false);
  }
}

/** Blocks an IP, optionally deleting its pending applications. Used by the drawer and settings. */
async function blockFlow(ip) {
  const pending = S.apps.filter((x) => x.ip === ip && x.status === 'pending').length;
  const vals = await promptDialog({
    title: `${ip} engellensin mi?`,
    text: 'Bu adresten yeni başvuru kabul edilmez. Not: okullar ve mobil operatörler aynı IP adresini birçok kişiyle paylaşabilir.',
    fields: [
      { name: 'reason', label: 'Neden (isteğe bağlı)', placeholder: 'Örn. sahte başvurular' },
      ...(pending ? [{ name: 'delete_pending', type: 'checkbox', label: `Bu adresten gelen ${pending} bekleyen başvuruyu da sil` , value: true }] : []),
    ],
    ok: 'Engelle',
  });
  if (!vals) return false;
  try {
    const res = await authed('/api/admin/blocked-ips', { method: 'POST', body: { ip, reason: vals.reason, delete_pending: vals.delete_pending === true } });
    S.blocked = res.blocked;
    if (res.deleted) {
      await loadApps();
      if (S.openId && !S.apps.some((x) => x.id === S.openId)) closeDrawer();
    }
    toast(res.deleted ? `IP engellendi, ${res.deleted} başvuru silindi.` : 'IP engellendi.');
    refreshView();
    const open = S.openId && S.apps.find((x) => x.id === S.openId);
    if (open) renderDrawer(open, null);
    return true;
  } catch (err) {
    toast(err.message, { type: 'bad' });
    return false;
  }
}

// ---------- calendar view ----------

function renderCalendar() {
  if (!S.month) {
    const next = S.apps.filter((a) => a.status === 'approved' && a.visit_date >= S.today).sort((x, y) => x.visit_date.localeCompare(y.visit_date))[0];
    const base = parseISO(S.today);
    S.month = { y: base.y, m: base.m };
    S.selDay = next && next.visit_date.slice(0, 7) === S.today.slice(0, 7) ? next.visit_date : S.today;
  }
  const { y, m } = S.month;
  const cap = S.settings.daily_capacity;
  const closed = closedMap();
  const first = toISO(y, m, 1);
  const start = addDays(first, -(isoWeekday(first) - 1));
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = toISO(y, m, daysIn);
  const end = addDays(last, 7 - isoWeekday(last));

  const visitsBy = new Map();
  const reqBy = new Map();
  for (const a of S.apps) {
    if (a.status === 'approved') {
      if (!visitsBy.has(a.visit_date)) visitsBy.set(a.visit_date, []);
      visitsBy.get(a.visit_date).push(a);
    } else if (a.status === 'pending') {
      for (const d of a.preferred_dates) reqBy.set(d, (reqBy.get(d) || 0) + 1);
    }
  }
  for (const list of visitsBy.values()) list.sort((p, q) => p.visit_time.localeCompare(q.visit_time));

  let cells = DAYS_SHORT.map((d) => `<div class="mcal__dow">${d}</div>`).join('');
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const other = d.slice(0, 7) !== first.slice(0, 7);
    const visits = visitsBy.get(d) || [];
    const used = visits.reduce((n, a) => n + a.student_count, 0);
    const req = reqBy.get(d) || 0;
    const isClosed = closed.has(d);
    const off = !S.settings.weekdays.includes(isoWeekday(d));
    const cls = ['mday', other ? 'mday--other' : '', off ? 'mday--off' : '', isClosed ? 'mday--closed' : '', d === S.today ? 'is-today' : '', d === S.selDay ? 'is-selected' : ''].join(' ');
    const label = `${fmtDate(d)}${visits.length ? `, ${visits.length} ziyaret, ${used} öğrenci` : ''}${req ? `, ${req} bekleyen talep` : ''}${isClosed ? ', kapalı' : ''}`;
    cells += `<button type="button" class="${cls}" data-day="${d}" aria-label="${esc(label)}" aria-pressed="${d === S.selDay}">
      <span class="mday__top"><span class="mday__n">${parseISO(d).d}</span>${req ? `<span class="mday__req">${req} talep</span>` : ''}</span>
      ${isClosed ? `<span class="mday__closed">Kapalı${closed.get(d) ? ` · ${esc(closed.get(d))}` : ''}</span>` : ''}
      ${visits.slice(0, 3).map((a) => `<span class="chip-visit">${esc(a.visit_time)} ${esc(a.school_name)}</span>`).join('')}
      ${visits.length > 3 ? `<span class="chip-more">+${visits.length - 3} ziyaret daha</span>` : ''}
      ${used ? meterHTML(used, 0, cap) : ''}
    </button>`;
  }

  $('#view').innerHTML = `
    <div class="view-head">
      <div><h1>Takvim</h1><p>Onaylı ziyaretler ve bekleyen taleplerin tercih ettiği günler.</p></div>
      <div class="mcal-head">
        <h2 aria-live="polite">${MONTHS[m - 1]} ${y}</h2>
        <button class="icon-btn" type="button" id="m-prev" aria-label="Önceki ay" style="border:1.5px solid var(--line)">${icon('chevron-left')}</button>
        <button class="icon-btn" type="button" id="m-next" aria-label="Sonraki ay" style="border:1.5px solid var(--line)">${icon('chevron-right')}</button>
        <button class="btn btn--sm" type="button" id="m-today">Bugün</button>
      </div>
    </div>
    <div class="cal-layout">
      <div>
        <div class="mcal">${cells}</div>
        <div class="legend-row">
          <span><i style="background:var(--ok-soft)"></i>Onaylı ziyaret</span>
          <span><i style="background:var(--warn-soft)"></i>Bekleyen talep</span>
          <span><i style="background:repeating-linear-gradient(135deg,#fff 0 3px,var(--paper-2) 3px 6px);border:1px solid var(--line)"></i>Kapalı gün</span>
          <span>Günlük kontenjan: <b>${cap}</b></span>
        </div>
      </div>
      <aside class="daypanel box" id="daypanel" aria-live="polite"></aside>
    </div>`;

  $('#m-prev').addEventListener('click', () => shiftMonth(-1));
  $('#m-next').addEventListener('click', () => shiftMonth(1));
  $('#m-today').addEventListener('click', () => { const t = parseISO(S.today); S.month = { y: t.y, m: t.m }; S.selDay = S.today; renderCalendar(); });
  $$('.mday').forEach((b) => b.addEventListener('click', () => {
    S.selDay = b.dataset.day;
    const p = parseISO(S.selDay);
    if (p.m !== S.month.m || p.y !== S.month.y) { S.month = { y: p.y, m: p.m }; renderCalendar(); return; }
    $$('.mday').forEach((x) => { x.classList.toggle('is-selected', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    renderDayPanel(visitsBy);
  }));
  renderDayPanel(visitsBy);
}

function shiftMonth(n) {
  let { y, m } = S.month;
  m += n;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  S.month = { y, m };
  S.selDay = toISO(y, m, 1) <= S.today && S.today <= toISO(y, m, 31) ? S.today : null;
  renderCalendar();
}

function renderDayPanel(visitsBy) {
  const panel = $('#daypanel');
  const d = S.selDay;
  if (!d) { panel.innerHTML = '<p class="hint">Ayrıntılar için takvimden bir gün seçin.</p>'; return; }
  const cap = S.settings.daily_capacity;
  const visits = visitsBy.get(d) || [];
  const used = visits.reduce((n, a) => n + a.student_count, 0);
  const reqs = S.apps.filter((a) => a.status === 'pending' && a.preferred_dates.includes(d));
  const closed = closedMap();
  const isClosed = closed.has(d);
  panel.innerHTML = `
    <h3 class="daypanel__title">${esc(fmtDate(d, { year: true }))}</h3>
    ${meterHTML(used, 0, cap)}
    <p class="hint">${used} / ${cap} öğrenci · ${Math.max(0, cap - used)} kişilik yer var${dayWarning(d) ? ` · ${esc(dayWarning(d))}` : ''}</p>
    <div>
      <h3 style="font-size:.8125rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);margin:6px 0 8px">Onaylı ziyaretler</h3>
      ${visits.length ? `<ul class="daylist">${visits.map((a) => `<li><button type="button" data-open="${a.id}"><span class="t">${esc(a.visit_time)}</span><span><b>${esc(a.school_name)}</b><small>${esc(a.teacher_name)} · ${esc(fmtPhone(a.phone))}</small></span><span class="n">${a.student_count}</span></button></li>`).join('')}</ul>` : '<p class="hint">Bu gün için onaylı ziyaret yok.</p>'}
    </div>
    <div>
      <h3 style="font-size:.8125rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);margin:6px 0 8px">Bu günü isteyen bekleyen başvurular</h3>
      ${reqs.length ? `<ul class="daylist">${reqs.map((a) => `<li><button type="button" data-open="${a.id}"><span class="t">${a.preferred_dates.indexOf(d) + 1}. tercih</span><span><b>${esc(a.school_name)}</b><small>${esc(a.time_pref)} · ${esc(relTime(a.created_at))}</small></span><span class="n">${a.student_count}</span></button></li>`).join('')}</ul>` : '<p class="hint">Bu günü tercih eden bekleyen başvuru yok.</p>'}
    </div>
    <div class="btn-row" style="padding-top:8px;border-top:1px solid var(--line)">
      ${isClosed
        ? `<button class="btn btn--sm" type="button" id="day-open">${icon('check')}Ziyarete aç</button><span class="hint" style="align-self:center">Kapalı${closed.get(d) ? `: ${esc(closed.get(d))}` : ''}</span>`
        : `<button class="btn btn--sm" type="button" id="day-close">${icon('ban')}Bu günü ziyarete kapat</button>`}
    </div>`;
  $$('[data-open]', panel).forEach((b) => b.addEventListener('click', () => go('takvim', b.dataset.open)));
  $('#day-close')?.addEventListener('click', async () => {
    const vals = await promptDialog({
      title: `${fmtDate(d)} kapatılsın mı?`,
      text: 'Öğretmenler bu günü takvimde seçemez. Onaylı ziyaretler etkilenmez.',
      fields: [{ name: 'reason', label: 'Neden (isteğe bağlı)', placeholder: 'Örn. Sınav haftası' }],
      ok: 'Günü kapat',
    });
    if (!vals) return;
    try {
      const res = await authed('/api/admin/closed-days', { method: 'POST', body: { date: d, reason: vals.reason } });
      S.closed = res.closed_days;
      toast('Gün ziyarete kapatıldı.');
      renderCalendar();
    } catch (err) { toast(err.message, { type: 'bad' }); }
  });
  $('#day-open')?.addEventListener('click', async () => {
    try {
      const res = await authed(`/api/admin/closed-days/${d}`, { method: 'DELETE' });
      S.closed = res.closed_days;
      toast('Gün yeniden ziyarete açıldı.');
      renderCalendar();
    } catch (err) { toast(err.message, { type: 'bad' }); }
  });
}

// ---------- settings view ----------

const WEEKDAY_NAMES = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

function renderSettings() {
  const s = S.settings;
  const isAdmin = S.user.role === 'admin';
  $('#view').innerHTML = `
    <div class="view-head"><div><h1>Ayarlar</h1><p>Başvuru formunun ve takvimin nasıl çalışacağını belirleyin.</p></div></div>
    <div class="settings">
      <section class="panel-card">
        <div class="panel-card__head">${icon('inbox')}<div><h2>Başvuru durumu</h2><p>Formu geçici olarak kapatabilir, ziyaretçilere bir duyuru gösterebilirsiniz.</p></div></div>
        <label class="switch"><span><b>Başvurular açık</b><small>Kapalıyken öğretmenler form gönderemez.</small></span><input type="checkbox" id="booking_open" ${s.booking_open ? 'checked' : ''}></label>
        <form id="notice-form" novalidate style="margin-top:16px">
          <div class="field">
            <label class="label" for="notice">Form duyurusu <span class="opt">(isteğe bağlı)</span></label>
            <textarea class="textarea" id="notice" name="notice" maxlength="400" placeholder="Örn. Kasım ayında ziyaretler yalnızca salı ve perşembe günleri yapılacaktır.">${esc(s.notice)}</textarea>
            <p class="hint">Başvuru formunun en üstünde görünür.</p>
          </div>
          <div class="card-actions"><button class="btn btn--primary btn--sm" type="submit">Duyuruyu kaydet</button></div>
        </form>
      </section>

      <section class="panel-card">
        <div class="panel-card__head">${icon('users')}<div><h2>Kontenjan ve günler</h2><p>Öğretmenlerin takvimde görebileceği günler.</p></div></div>
        <form id="cap-form" novalidate>
          <div class="field">
            <label class="label" for="daily_capacity">Günlük en fazla öğrenci</label>
            <input class="input" type="number" inputmode="numeric" id="daily_capacity" name="daily_capacity" min="1" max="2000" value="${s.daily_capacity}" style="max-width:160px">
            <p class="error-text" data-error-for="daily_capacity"></p>
          </div>
          <fieldset class="field" style="border:0;padding:0;margin:18px 0 0">
            <legend class="label" style="padding:0;margin-bottom:6px">Ziyaret kabul edilen günler</legend>
            <div class="weekdays" data-control-for="weekdays">
              ${WEEKDAY_NAMES.map((n, i) => `<input type="checkbox" id="wd${i + 1}" value="${i + 1}" ${s.weekdays.includes(i + 1) ? 'checked' : ''}><label for="wd${i + 1}">${n}</label>`).join('')}
            </div>
            <p class="error-text" data-error-for="weekdays"></p>
          </fieldset>
          <div class="grid-2" style="margin-top:18px">
            <div class="field">
              <label class="label" for="min_lead_days">En az kaç gün önceden</label>
              <input class="input" type="number" inputmode="numeric" id="min_lead_days" name="min_lead_days" min="0" max="60" value="${s.min_lead_days}">
              <p class="error-text" data-error-for="min_lead_days"></p>
            </div>
            <div class="field">
              <label class="label" for="max_ahead_days">En fazla kaç gün sonrası</label>
              <input class="input" type="number" inputmode="numeric" id="max_ahead_days" name="max_ahead_days" min="7" max="400" value="${s.max_ahead_days}">
              <p class="error-text" data-error-for="max_ahead_days"></p>
            </div>
            <div class="field span-2">
              <label class="label" for="season_end">Tanıtım döneminin son günü <span class="opt">(isteğe bağlı)</span></label>
              <input class="input" type="date" id="season_end" name="season_end" value="${esc(s.season_end)}" style="max-width:220px">
              <p class="error-text" data-error-for="season_end"></p>
            </div>
          </div>
          <div class="card-actions"><button class="btn btn--primary btn--sm" type="submit">Kaydet</button></div>
        </form>
      </section>

      <section class="panel-card">
        <div class="panel-card__head">${icon('ban')}<div><h2>Kapalı günler</h2><p>Tatil, sınav haftası gibi ziyaret kabul edilmeyen günler.</p></div></div>
        <form id="closed-form" novalidate>
          <div class="grid-2">
            <div class="field"><label class="label" for="c_date">Başlangıç</label><input class="input" type="date" id="c_date" name="date" min="${S.today}"><p class="error-text" data-error-for="date"></p></div>
            <div class="field"><label class="label" for="c_until">Bitiş <span class="opt">(tek gün için boş)</span></label><input class="input" type="date" id="c_until" name="until" min="${S.today}"></div>
            <div class="field span-2"><label class="label" for="c_reason">Neden <span class="opt">(isteğe bağlı)</span></label><input class="input" id="c_reason" name="reason" maxlength="80" placeholder="Örn. Cumhuriyet Bayramı"></div>
          </div>
          <div class="card-actions"><button class="btn btn--primary btn--sm" type="submit">${icon('plus')}Ekle</button></div>
        </form>
        <ul class="closed-list" id="closed-list"></ul>
      </section>

      <section class="panel-card">
        <div class="panel-card__head">${icon('shield')}<div><h2>Engellenen IP'ler</h2><p>Bu adreslerden başvuru kabul edilmez. Okullar ve mobil operatörler aynı IP'yi paylaşabilir; dikkatli kullanın.</p></div></div>
        <form id="block-form" novalidate>
          <div class="grid-2">
            <div class="field"><label class="label" for="b_ip">IP adresi</label><input class="input mono" id="b_ip" name="ip" autocomplete="off" spellcheck="false" placeholder="örn. 203.0.113.7"><p class="error-text" data-error-for="ip"></p></div>
            <div class="field"><label class="label" for="b_reason">Neden <span class="opt">(isteğe bağlı)</span></label><input class="input" id="b_reason" name="reason" maxlength="120"></div>
          </div>
          <div class="card-actions"><button class="btn btn--primary btn--sm" type="submit">${icon('ban')}Engelle</button></div>
        </form>
        <ul class="closed-list" id="blocked-list"></ul>
      </section>

      <section class="panel-card">
        <div class="panel-card__head">${icon('lock')}<div><h2>Şifremi değiştir</h2><p>${esc(S.user.display_name)} (${esc(S.user.username)})</p></div></div>
        <form id="pw-form" novalidate>
          <div class="field"><label class="label" for="pw_current">Mevcut şifre</label><input class="input" type="password" id="pw_current" name="current" autocomplete="current-password"><p class="error-text" data-error-for="current"></p></div>
          <div class="field"><label class="label" for="pw_next">Yeni şifre</label><input class="input" type="password" id="pw_next" name="next" autocomplete="new-password" aria-describedby="pw-hint"><p class="hint" id="pw-hint">En az 8 karakter.</p><p class="error-text" data-error-for="next"></p></div>
          <div class="field"><label class="label" for="pw_again">Yeni şifre (tekrar)</label><input class="input" type="password" id="pw_again" name="again" autocomplete="new-password"><p class="error-text" data-error-for="again"></p></div>
          <div class="card-actions"><button class="btn btn--primary btn--sm" type="submit">Şifreyi değiştir</button></div>
        </form>
      </section>

      ${isAdmin ? `
      <section class="panel-card span-all">
        <div class="panel-card__head">${icon('users')}<div><h2>Hesaplar</h2><p>Panele giriş yapabilen kişiler. Yalnızca yönetici hesapları bu bölümü görür.</p></div></div>
        <ul class="users" id="users"><li><div class="skel" style="height:40px;width:100%"></div></li></ul>
        <form id="user-form" novalidate style="margin-top:20px;padding-top:20px;border-top:1px solid var(--line)">
          <h3 style="font-size:1rem;font-weight:750;margin-bottom:14px">Yeni hesap</h3>
          <div class="grid-2">
            <div class="field"><label class="label" for="u_username">Kullanıcı adı</label><input class="input" id="u_username" name="username" autocapitalize="off" spellcheck="false" placeholder="örn. ayse.ogretmen"><p class="error-text" data-error-for="username"></p></div>
            <div class="field"><label class="label" for="u_display">Görünen ad</label><input class="input" id="u_display" name="display_name" placeholder="örn. Ayşe Hoca"><p class="error-text" data-error-for="display_name"></p></div>
            <div class="field"><label class="label" for="u_role">Yetki</label><select class="select" id="u_role" name="role"><option value="staff">Rehberlik (başvuru ve ayarlar)</option><option value="admin">Yönetici (hesaplar dahil)</option></select></div>
            <div class="field"><label class="label" for="u_password">Şifre</label><input class="input" id="u_password" name="password" type="text" autocomplete="off" spellcheck="false"><p class="error-text" data-error-for="password"></p></div>
          </div>
          <div class="card-actions"><button class="btn btn--primary btn--sm" type="submit">${icon('plus')}Hesap ekle</button></div>
        </form>
      </section>` : ''}
    </div>`;

  renderClosedList();
  renderBlockedList();
  if (isAdmin) loadUsers();

  $('#block-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const ip = form.ip.value.trim();
    if (!ip) { showFieldErrors(form, { ip: 'IP adresini yazın.' }); return; }
    const btn = form.querySelector('[type=submit]');
    setLoading(btn, true);
    try {
      const res = await authed('/api/admin/blocked-ips', { method: 'POST', body: { ip, reason: form.reason.value } });
      S.blocked = res.blocked;
      form.reset();
      showFieldErrors(form, {});
      renderBlockedList();
      toast('IP engellendi.');
    } catch (err) { showFieldErrors(form, err.data?.fields || {}); toast(err.message, { type: 'bad' }); }
    setLoading(btn, false);
  });

  $('#booking_open').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      await saveSettings({ booking_open: on });
      toast(on ? 'Başvurular açıldı.' : 'Başvurular kapatıldı.');
    } catch { e.target.checked = !on; }
  });
  $('#notice-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('[type=submit]');
    setLoading(btn, true);
    try { await saveSettings({ notice: $('#notice').value }); toast('Duyuru kaydedildi.'); } catch { /* toasted */ }
    setLoading(btn, false);
  });
  $('#cap-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = {
      daily_capacity: Number($('#daily_capacity').value),
      weekdays: $$('.weekdays input:checked', form).map((i) => Number(i.value)),
      min_lead_days: Number($('#min_lead_days').value),
      max_ahead_days: Number($('#max_ahead_days').value),
      season_end: $('#season_end').value,
    };
    if (!body.weekdays.length) { showFieldErrors(form, { weekdays: 'En az bir gün seçin.' }); return; }
    const btn = form.querySelector('[type=submit]');
    setLoading(btn, true);
    try { await saveSettings(body, form); toast('Ayarlar kaydedildi.'); } catch { /* shown */ }
    setLoading(btn, false);
  });
  $('#closed-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = { date: form.date.value, until: form.until.value || form.date.value, reason: form.reason.value };
    if (!body.date) { showFieldErrors(form, { date: 'Bir tarih seçin.' }); return; }
    if (body.until < body.date) { showFieldErrors(form, { date: 'Bitiş, başlangıçtan önce olamaz.' }); return; }
    showFieldErrors(form, {});
    const btn = form.querySelector('[type=submit]');
    setLoading(btn, true);
    try {
      const res = await authed('/api/admin/closed-days', { method: 'POST', body });
      S.closed = res.closed_days;
      form.reset();
      renderClosedList();
      toast('Kapalı gün eklendi.');
    } catch (err) { showFieldErrors(form, err.data?.fields || {}); toast(err.message, { type: 'bad' }); }
    setLoading(btn, false);
  });
  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const errs = {};
    if (!form.current.value) errs.current = 'Mevcut şifrenizi yazın.';
    if (form.next.value.length < 8) errs.next = 'Yeni şifre en az 8 karakter olmalı.';
    else if (form.next.value !== form.again.value) errs.again = 'Şifreler eşleşmiyor.';
    if (Object.keys(errs).length) { showFieldErrors(form, errs)?.focus(); return; }
    showFieldErrors(form, {});
    const btn = form.querySelector('[type=submit]');
    setLoading(btn, true);
    try {
      await authed('/api/auth/password', { method: 'POST', body: { current: form.current.value, next: form.next.value } });
      form.reset();
      toast('Şifreniz değiştirildi. Diğer cihazlardaki oturumlar kapatıldı.');
    } catch (err) { showFieldErrors(form, err.data?.fields || {}); toast(err.message, { type: 'bad' }); }
    setLoading(btn, false);
  });
  $('#user-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = { username: form.username.value.trim(), display_name: form.display_name.value.trim(), role: form.role.value, password: form.password.value };
    const btn = form.querySelector('[type=submit]');
    setLoading(btn, true);
    try {
      const res = await authed('/api/admin/users', { method: 'POST', body });
      form.reset();
      showFieldErrors(form, {});
      renderUsers(res.users);
      toast('Hesap eklendi. Şifreyi kişiye güvenli bir yoldan iletin.');
    } catch (err) { showFieldErrors(form, err.data?.fields || {}); toast(err.message, { type: 'bad' }); }
    setLoading(btn, false);
  });
}

async function saveSettings(body, form) {
  try {
    const res = await authed('/api/admin/settings', { method: 'PUT', body });
    S.settings = res.settings;
    S.closed = res.closed_days;
    if (form) showFieldErrors(form, {});
  } catch (err) {
    if (form && err.data?.fields) showFieldErrors(form, err.data.fields);
    toast(err.message, { type: 'bad' });
    throw err;
  }
}

function renderClosedList() {
  const ul = $('#closed-list');
  const upcoming = S.closed.filter((c) => c.date >= S.today);
  ul.innerHTML = upcoming.length
    ? upcoming.map((c) => `<li><span><b>${esc(fmtDate(c.date))}</b>${c.reason ? `<br><small>${esc(c.reason)}</small>` : ''}</span><button class="icon-btn" type="button" data-del="${c.date}" aria-label="${esc(fmtDate(c.date))} kapalı gününü kaldır">${icon('trash')}</button></li>`).join('')
    : '<li><span class="hint">Yaklaşan kapalı gün yok.</span></li>';
  $$('[data-del]', ul).forEach((b) => b.addEventListener('click', async () => {
    try {
      const res = await authed(`/api/admin/closed-days/${b.dataset.del}`, { method: 'DELETE' });
      S.closed = res.closed_days;
      renderClosedList();
      toast('Kapalı gün kaldırıldı.');
    } catch (err) { toast(err.message, { type: 'bad' }); }
  }));
}

function renderBlockedList() {
  const ul = $('#blocked-list');
  if (!ul) return;
  ul.innerHTML = S.blocked.length
    ? S.blocked.map((b) => `<li><span><b class="mono">${esc(b.ip)}</b><br><small>${b.reason ? `${esc(b.reason)} · ` : ''}${b.applications} başvuru · ${esc(b.created_by)}, ${esc(relTime(b.created_at))}</small></span><button class="icon-btn" type="button" data-unblock="${esc(b.ip)}" aria-label="${esc(b.ip)} engelini kaldır">${icon('trash')}</button></li>`).join('')
    : '<li><span class="hint">Engellenmiş IP yok.</span></li>';
  $$('[data-unblock]', ul).forEach((b) => b.addEventListener('click', async () => {
    try {
      const res = await authed(`/api/admin/blocked-ips/${encodeURIComponent(b.dataset.unblock)}`, { method: 'DELETE' });
      S.blocked = res.blocked;
      renderBlockedList();
      toast('Engel kaldırıldı.');
    } catch (err) { toast(err.message, { type: 'bad' }); }
  }));
}

async function loadUsers() {
  try {
    const res = await authed('/api/admin/users');
    renderUsers(res.users);
  } catch (err) { toast(err.message, { type: 'bad' }); }
}

function renderUsers(users) {
  const ul = $('#users');
  if (!ul) return;
  ul.innerHTML = users.map((u) => `<li>
    <span class="avatar" aria-hidden="true">${esc(u.display_name.charAt(0).toLocaleUpperCase('tr'))}</span>
    <div><b>${esc(u.display_name)}</b> <span class="role-tag${u.role === 'admin' ? ' role-tag--admin' : ''}">${u.role === 'admin' ? 'Yönetici' : 'Rehberlik'}</span><br>
      <small>${esc(u.username)} · ${u.last_login ? `son giriş ${esc(relTime(u.last_login))}` : 'henüz giriş yapmadı'}</small></div>
    <button class="btn btn--sm" type="button" data-reset="${u.id}" data-name="${esc(u.display_name)}">${icon('lock')}Şifre</button>
    ${u.id !== S.user.id ? `<button class="icon-btn" type="button" data-remove="${u.id}" data-name="${esc(u.display_name)}" aria-label="${esc(u.display_name)} hesabını sil">${icon('trash')}</button>` : ''}
  </li>`).join('');
  $$('[data-reset]', ul).forEach((b) => b.addEventListener('click', async () => {
    const vals = await promptDialog({
      title: `${b.dataset.name} için yeni şifre`,
      text: 'Kişinin açık oturumları kapatılır. Yeni şifreyi kendisine güvenli bir yoldan iletin.',
      fields: [{ name: 'password', label: 'Yeni şifre (en az 8 karakter)', type: 'text' }],
      ok: 'Şifreyi değiştir',
      validate: (v) => (v.password.length < 8 ? 'Şifre en az 8 karakter olmalı.' : ''),
    });
    if (!vals) return;
    try {
      const res = await authed(`/api/admin/users/${b.dataset.reset}`, { method: 'PATCH', body: { password: vals.password } });
      renderUsers(res.users);
      toast('Şifre değiştirildi.');
    } catch (err) { toast(err.message, { type: 'bad' }); }
  }));
  $$('[data-remove]', ul).forEach((b) => b.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: `${b.dataset.name} hesabı silinsin mi?`, text: 'Bu kişi panele artık giriş yapamaz.', ok: 'Sil', danger: true });
    if (!ok) return;
    try {
      const res = await authed(`/api/admin/users/${b.dataset.remove}`, { method: 'DELETE' });
      renderUsers(res.users);
      toast('Hesap silindi.');
    } catch (err) { toast(err.message, { type: 'bad' }); }
  }));
}

// ---------- prompt dialog ----------

function promptDialog({ title, text = '', fields, ok = 'Kaydet', validate }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    d.innerHTML = `
      <form method="dialog" novalidate>
        <div class="modal__body">
          <h2 class="modal__title">${esc(title)}</h2>
          ${text ? `<p class="modal__text">${esc(text)}</p>` : ''}
          ${fields.map((f, i) => (f.type === 'checkbox'
            ? `<label class="check" style="margin-top:8px"><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}><span>${esc(f.label)}</span></label>`
            : `<div class="field" style="margin-top:8px"><label class="label" for="pd${i}">${esc(f.label)}</label><input class="input" id="pd${i}" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off"></div>`)).join('')}
          <p class="error-text" id="pd-error"></p>
        </div>
        <div class="modal__actions">
          <button class="btn" value="no" formnovalidate>Vazgeç</button>
          <button class="btn btn--primary" value="yes">${esc(ok)}</button>
        </div>
      </form>`;
    document.body.append(d);
    const form = d.querySelector('form');
    const values = () => Object.fromEntries(fields.map((f) => [f.name, f.type === 'checkbox' ? form.elements[f.name].checked : form.elements[f.name].value.trim()]));
    form.addEventListener('submit', (e) => {
      if (e.submitter?.value !== 'yes') return;
      const msg = validate?.(values());
      if (msg) { e.preventDefault(); $('#pd-error', d).innerHTML = `${icon('alert')}<span>${esc(msg)}</span>`; }
    });
    d.addEventListener('close', () => { resolve(d.returnValue === 'yes' ? values() : null); d.remove(); });
    d.showModal();
    d.querySelector('input')?.focus();
  });
}

boot();
