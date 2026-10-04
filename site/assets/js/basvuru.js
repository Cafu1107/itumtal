import {
  api, $, $$, esc, icon, fmtDate, fmtPhone, MONTHS, DAYS_SHORT, parseISO, toISO, isoWeekday,
  toast, setLoading, copyText, showFieldErrors, saveApplication, bindTurnstile,
} from './common.js';
import { initHeader } from './site.js';

initHeader();

const form = $('#apply');
const startedAt = Date.now();
const human = bindTurnstile($('#turnstile'));
const DRAFT_KEY = 'itumtal.taslak';
const MAX_PICKS = 3;

const state = {
  cfg: null,
  picks: [],          // ISO dates in preference order
  month: null,        // { y, m }
  focusDate: null,    // roving focus in the calendar
};

const count = () => {
  const n = parseInt($('#student_count').value, 10);
  return Number.isFinite(n) ? n : 0;
};
const remaining = (iso) => state.cfg?.days[iso];
const lowLimit = () => Math.max(20, Math.round((state.cfg?.daily_capacity || 120) * 0.25));

// ---------- boot ----------

async function boot() {
  restoreDraft();
  try {
    state.cfg = await api('/api/config');
  } catch (err) {
    $('#cal-grid').innerHTML = `<div class="callout callout--bad" style="grid-column:1/-1">${icon('alert')}<span>Takvim yüklenemedi. ${esc(err.message)} <button class="btn btn--sm" type="button" id="retry">Tekrar dene</button></span></div>`;
    $('#retry').addEventListener('click', () => location.reload());
    return;
  }
  const cfg = state.cfg;

  $$('[data-capacity]').forEach((el) => { el.textContent = cfg.daily_capacity; });
  $('#student_count').max = cfg.daily_capacity;
  fillSelect($('#district'), cfg.options.districts);
  fillSelect($('#teacher_role'), cfg.options.roles);
  restoreDraft(); // again, now that the selects have options

  const notices = $('#notices');
  if (!cfg.booking_open) {
    notices.insertAdjacentHTML('beforeend', `<div class="callout callout--bad">${icon('ban')}<span><b>Ziyaret başvuruları şu anda kapalı.</b> Bilgi için okulumuzu 0212 261 24 20 numarasından arayabilirsiniz.</span></div>`);
    $$('input, select, textarea, button[type="submit"]', form).forEach((el) => { el.disabled = true; });
  }
  if (cfg.notice) {
    notices.insertAdjacentHTML('beforeend', `<div class="callout">${icon('info')}<span style="white-space:pre-line">${esc(cfg.notice)}</span></div>`);
  }

  // keep only picks that are still open
  state.picks = state.picks.filter((d) => remaining(d) !== undefined);

  const firstOpen = Object.keys(cfg.days)[0] || cfg.first_day;
  const start = state.picks[0] || firstOpen;
  const { y, m } = parseISO(start);
  state.month = { y, m };
  renderCalendar();
  renderPicks();
  renderSummary();
}

function fillSelect(sel, values) {
  const current = sel.value;
  sel.innerHTML = '<option value="">Seçin</option>' + values.map((v) => `<option>${esc(v)}</option>`).join('');
  sel.value = current;
}

// ---------- calendar ----------

function monthBounds() {
  const a = parseISO(state.cfg.first_day);
  const b = parseISO(state.cfg.last_day);
  return { min: a.y * 12 + a.m, max: b.y * 12 + b.m };
}

function dayState(iso) {
  const left = remaining(iso);
  if (left === undefined) return 'off';
  if (left < Math.max(1, count())) return 'full';
  if (left <= lowLimit()) return 'low';
  return 'open';
}

function dayLabel(iso, st) {
  const left = remaining(iso);
  const base = fmtDate(iso);
  if (st === 'off') return `${base}, ziyarete kapalı`;
  if (st === 'full') return left === 0 ? `${base}, dolu` : `${base}, ${left} kişilik yer var, grubunuza yetmiyor`;
  const picked = state.picks.indexOf(iso);
  return `${base}, ${left} kişilik yer var${picked >= 0 ? `, ${picked + 1}. tercihiniz` : ''}`;
}

function renderCalendar() {
  const { y, m } = state.month;
  $('#cal-title').textContent = `${MONTHS[m - 1]} ${y}`;
  const { min, max } = monthBounds();
  $('#cal-prev').disabled = y * 12 + m <= min;
  $('#cal-next').disabled = y * 12 + m >= max;

  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = isoWeekday(toISO(y, m, 1)) - 1;
  let html = DAYS_SHORT.map((d) => `<div class="cal__dow" aria-hidden="true">${d}</div>`).join('');
  for (let i = 0; i < lead; i++) html += '<div class="day day--blank" aria-hidden="true"></div>';

  const focusables = [];
  for (let d = 1; d <= daysIn; d++) {
    const iso = toISO(y, m, d);
    const st = dayState(iso);
    const left = remaining(iso);
    const pickIdx = state.picks.indexOf(iso);
    if (st === 'off') {
      html += `<div class="day day--off" aria-label="${esc(dayLabel(iso, st))}"><span class="day__n">${d}</span></div>`;
      continue;
    }
    focusables.push(iso);
    const cls = ['day', st === 'full' ? 'day--full' : '', st === 'low' ? 'day--low' : '', pickIdx >= 0 ? 'is-selected' : ''].join(' ');
    const leftText = st === 'full' ? (left === 0 ? 'dolu' : `${left}<span class="u"> yer</span>`) : `${left}<span class="u"> yer</span>`;
    html += `<button type="button" class="${cls}" data-date="${iso}" aria-pressed="${pickIdx >= 0}" ${st === 'full' ? 'aria-disabled="true"' : ''} aria-label="${esc(dayLabel(iso, st))}" tabindex="-1">
      <span class="day__n">${d}</span><span class="day__left">${leftText}</span>
      ${pickIdx >= 0 ? `<span class="day__badge" aria-hidden="true">${pickIdx + 1}</span>` : ''}
    </button>`;
  }
  $('#cal-grid').innerHTML = html;

  if (!focusables.includes(state.focusDate)) state.focusDate = focusables.find((d) => state.picks.includes(d)) || focusables[0] || null;
  const f = state.focusDate && $(`[data-date="${state.focusDate}"]`);
  if (f) f.tabIndex = 0;
}

$('#cal-prev').addEventListener('click', () => shiftMonth(-1));
$('#cal-next').addEventListener('click', () => shiftMonth(1));
function shiftMonth(n) {
  let { y, m } = state.month;
  m += n;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  state.month = { y, m };
  state.focusDate = null;
  renderCalendar();
}

$('#cal-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('button.day');
  if (!btn) return;
  togglePick(btn.dataset.date);
});

$('#cal-grid').addEventListener('keydown', (e) => {
  const btn = e.target.closest('button.day');
  if (!btn) return;
  const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  if (!(e.key in moves)) return;
  e.preventDefault();
  const all = $$('button.day', $('#cal-grid'));
  const dates = all.map((b) => b.dataset.date);
  const cur = btn.dataset.date;
  // move by calendar days, then snap to the nearest focusable day in that direction
  const step = moves[e.key];
  const target = new Date(Date.parse(cur + 'T00:00:00Z') + step * 86400000).toISOString().slice(0, 10);
  let next = dates.find((d) => (step > 0 ? d >= target : false)) ?? null;
  if (step < 0) next = [...dates].reverse().find((d) => d <= target) ?? null;
  if (!next) return;
  all.forEach((b) => { b.tabIndex = -1; });
  const nb = $(`[data-date="${next}"]`);
  nb.tabIndex = 0;
  nb.focus();
  state.focusDate = next;
});

function togglePick(iso) {
  const st = dayState(iso);
  const i = state.picks.indexOf(iso);
  if (i >= 0) {
    state.picks.splice(i, 1);
  } else {
    if (st === 'full') {
      const left = remaining(iso);
      toast(left === 0 ? `${fmtDate(iso)} dolu.` : `${fmtDate(iso)} için ${left} kişilik yer kaldı; grubunuza yetmiyor.`, { type: 'bad' });
      return;
    }
    if (state.picks.length >= MAX_PICKS) {
      toast(`En fazla ${MAX_PICKS} gün seçebilirsiniz. Önce birini kaldırın.`, { type: 'bad' });
      return;
    }
    state.picks.push(iso);
  }
  state.focusDate = iso;
  renderCalendar();
  renderPicks();
  renderSummary();
  saveDraft();
  $(`[data-date="${iso}"]`)?.focus();
  showFieldErrors(form, {});
}

function renderPicks() {
  const ol = $('#picks');
  ol.innerHTML = state.picks.map((iso, i) => {
    const left = remaining(iso);
    return `<li class="pick">
      <span class="pick__no" aria-hidden="true">${i + 1}</span>
      <span class="pick__text"><b>${esc(fmtDate(iso, { year: true }))}</b><small>${i + 1}. tercih · ${left} kişilik yer var</small></span>
      <button class="icon-btn" type="button" data-remove="${iso}" aria-label="${esc(fmtDate(iso))} tercihini kaldır">${icon('x')}</button>
    </li>`;
  }).join('');
  $('#picks-empty').hidden = state.picks.length > 0;
}

$('#picks').addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove]');
  if (b) togglePick(b.dataset.remove);
});

// ---------- group size ----------

const countInput = $('#student_count');
function setCount(n) {
  const max = state.cfg?.daily_capacity || 120;
  countInput.value = Math.min(max, Math.max(1, n));
  onCountChange();
}
$$('.stepper [data-step]').forEach((b) => b.addEventListener('click', () => setCount(count() + Number(b.dataset.step))));
countInput.addEventListener('input', onCountChange);
countInput.addEventListener('blur', () => { if (count() < 1) setCount(1); });

function onCountChange() {
  if (!state.cfg) return;
  const n = count();
  const dropped = state.picks.filter((d) => remaining(d) < n);
  if (dropped.length && n > 0) {
    state.picks = state.picks.filter((d) => !dropped.includes(d));
    toast(`${dropped.map((d) => fmtDate(d, { weekday: false })).join(', ')} grubunuza yetmediği için tercihlerden çıkarıldı.`, { type: 'bad', ms: 4500 });
  }
  renderCalendar();
  renderPicks();
  renderSummary();
  saveDraft();
}

// ---------- summary ----------

function renderSummary() {
  const n = count();
  const grade = form.grade.value;
  const time = form.time_pref.value;
  const school = $('#school_name').value.trim();
  const picks = state.picks.length
    ? state.picks.map((d, i) => `${i + 1}. ${fmtDate(d, { weekday: false })}`).join('<br>')
    : '<span style="color:#b9c1d3;font-weight:400">Seçilmedi</span>';
  $('#summary').innerHTML = `
    <div><dt>Öğrenci</dt><dd class="num">${n || '—'}</dd></div>
    <div><dt>Sınıf</dt><dd>${esc(grade)}</dd></div>
    <div><dt>Tercihler</dt><dd>${picks}</dd></div>
    <div><dt>Saat</dt><dd>${esc(time)}</dd></div>
    <div><dt>Okul</dt><dd>${school ? esc(school) : '<span style="color:#b9c1d3;font-weight:400">—</span>'}</dd></div>`;
  $('#mobile-info').innerHTML = `<b>${n || 0} öğrenci</b>${state.picks.length ? `${state.picks.length} gün seçildi` : 'Gün seçilmedi'}`;
}

form.addEventListener('input', (e) => {
  if (e.target.name && e.target.getAttribute('aria-invalid') === 'true') {
    e.target.setAttribute('aria-invalid', 'false');
    const err = $(`[data-error-for="${e.target.name}"]`, form);
    if (err) err.innerHTML = '';
  }
  renderSummary();
  saveDraft();
});
form.addEventListener('change', () => { renderSummary(); saveDraft(); });

/** "+90 532 123 45 67" / "5321234567" -> "05321234567" (same rules as the API). */
function phoneDigits(v) {
  let d = String(v).replace(/\D/g, '');
  if (d.startsWith('0090')) d = d.slice(4);
  else if (d.startsWith('90') && d.length === 12) d = d.slice(2);
  if (d.length === 10) d = '0' + d;
  return d;
}

$('#phone').addEventListener('blur', (e) => {
  const d = phoneDigits(e.target.value);
  if (/^0[2-5]\d{9}$/.test(d)) e.target.value = fmtPhone(d);
});

// ---------- draft (this browser only) ----------

const DRAFT_FIELDS = ['student_count', 'escort_count', 'school_name', 'district', 'teacher_role', 'teacher_name', 'phone', 'email', 'note'];
function saveDraft() {
  try {
    const d = { picks: state.picks, grade: form.grade.value, time_pref: form.time_pref.value };
    for (const f of DRAFT_FIELDS) d[f] = form[f].value;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch { /* ignore */ }
}
function restoreDraft() {
  let d;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { d = null; }
  if (!d) return;
  for (const f of DRAFT_FIELDS) if (d[f] != null && d[f] !== '') form[f].value = d[f];
  for (const r of ['grade', 'time_pref']) {
    const el = d[r] && form.querySelector(`input[name="${r}"][value="${CSS.escape(d[r])}"]`);
    if (el) el.checked = true;
  }
  if (Array.isArray(d.picks) && !state.picks.length) state.picks = d.picks.slice(0, MAX_PICKS);
}
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } }

// ---------- validation + submit ----------

function collect() {
  return {
    school_name: $('#school_name').value.trim(),
    district: $('#district').value,
    teacher_name: $('#teacher_name').value.trim(),
    teacher_role: $('#teacher_role').value,
    phone: $('#phone').value.trim(),
    email: $('#email').value.trim(),
    student_count: count(),
    escort_count: $('#escort_count').value === '' ? 0 : Number($('#escort_count').value),
    grade: form.grade.value,
    time_pref: form.time_pref.value,
    preferred_dates: [...state.picks],
    note: $('#note').value.trim(),
    kvkk: $('#kvkk').checked,
    website: $('#website').value,
    started_at: startedAt,
  };
}

function validate(b) {
  const e = {};
  const cap = state.cfg?.daily_capacity || 120;
  if (!Number.isInteger(b.student_count) || b.student_count < 1) e.student_count = 'Öğrenci sayısını yazın.';
  else if (b.student_count > cap) e.student_count = `Bir günde en fazla ${cap} öğrenci ağırlayabiliyoruz.`;
  if (!Number.isInteger(b.escort_count) || b.escort_count < 0 || b.escort_count > 50) e.escort_count = '0 ile 50 arasında bir sayı yazın.';
  if (!b.preferred_dates.length) e.preferred_dates = 'Takvimden en az bir gün seçin.';
  if (b.school_name.length < 3) e.school_name = 'Okulunuzun adını yazın.';
  if (!b.district) e.district = 'İlçe seçin.';
  if (b.teacher_name.length < 3) e.teacher_name = 'Adınızı ve soyadınızı yazın.';
  if (!/^0[2-5]\d{9}$/.test(phoneDigits(b.phone))) e.phone = 'Geçerli bir telefon numarası yazın (örn. 0532 123 45 67).';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(b.email)) e.email = 'Geçerli bir e-posta adresi yazın.';
  if (!b.kvkk) e.kvkk = 'Devam etmek için aydınlatma metnini onaylayın.';
  return e;
}

function showErrors(fields, message) {
  const first = showFieldErrors(form, fields);
  const n = Object.keys(fields).length;
  const alert = $('#form-alert');
  if (n || message) {
    alert.innerHTML = `${icon('alert')}<span>${esc(message || (n === 1 ? 'Bir alanı kontrol etmeniz gerekiyor.' : `${n} alanı kontrol etmeniz gerekiyor.`))}</span>`;
    alert.hidden = false;
  } else {
    alert.hidden = true;
  }
  const target = first && first.closest('.field, .cal, .stepper, .seg') || (message ? alert : null);
  if (target) {
    target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    const focusable = first && (first.matches('input, select, textarea, button') ? first : first.querySelector('input, select, textarea, button:not([aria-disabled])'));
    setTimeout(() => focusable?.focus({ preventScroll: true }), 350);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.cfg || !state.cfg.booking_open) return;
  const body = collect();
  const errors = validate(body);
  if (Object.keys(errors).length) { showErrors(errors); return; }
  showErrors({});

  const buttons = $$('button[type="submit"]', form);
  buttons.forEach((b) => setLoading(b, true));
  try {
    body.turnstile = await human.token();
    const res = await api('/api/applications', { method: 'POST', body });
    clearDraft();
    const link = new URL(`takip.html?t=${res.token}`, location.href).href;
    saveApplication({ token: res.token, code: res.code, school: body.school_name, at: new Date().toISOString() });
    showDone(res, body, link);
  } catch (err) {
    if (err.status === 422 && err.data.fields) {
      showErrors(err.data.fields);
      // the calendar may be stale (someone else got approved meanwhile)
      if (err.data.fields.preferred_dates) refreshDays();
    } else {
      showErrors({}, err.message);
    }
  } finally {
    human.reset(); // tokens are single-use
    buttons.forEach((b) => setLoading(b, false));
  }
});

async function refreshDays() {
  try {
    state.cfg = await api('/api/config');
    renderCalendar();
    renderPicks();
  } catch { /* keep old */ }
}

function showDone(res, body, link) {
  form.hidden = true;
  $('#notices').hidden = true;
  $('#page-head').hidden = true;
  const done = $('#done');
  done.innerHTML = `
    <div class="done__card">
      <div class="done__top">
        <span class="done__mark">${icon('check')}</span>
        <h1 class="display" id="done-title">Başvurunuz alındı.</h1>
        <p>Teşekkürler ${esc(body.teacher_name.split(' ')[0])} Hocam. Rehberlik servisimiz en kısa sürede <b>${esc(fmtPhone(phoneDigits(body.phone)))}</b> numarasından sizinle iletişime geçecek.</p>
      </div>
      <div class="done__code">
        <div><small>Başvuru kodu</small><b>${esc(res.code)}</b></div>
        <p class="hint" style="max-width:36ch">Okulumuzla görüşürken bu kodu söylemeniz yeterli.</p>
      </div>
      <div class="done__link">
        <label class="label" for="track-link">Takip bağlantınız</label>
        <div class="linkbox">
          <input class="input" id="track-link" value="${esc(link)}" readonly>
          <button class="btn" type="button" id="copy-link">${icon('copy')}Kopyala</button>
        </div>
        <p class="hint">Başvurunuzun durumunu ve onaylanan ziyaret saatini bu bağlantıdan görebilir, gerekirse iptal edebilirsiniz. Bağlantı bu tarayıcıda da saklandı.</p>
        <div class="done__actions" style="margin-top:8px">
          <a class="btn btn--primary" href="${esc(link)}">Takip sayfasını aç ${icon('arrow-right', 'arrow')}</a>
          <a class="btn" href="./">Ana sayfaya dön</a>
        </div>
      </div>
    </div>`;
  done.hidden = false;
  window.scrollTo({ top: 0 });
  done.focus();
  $('#copy-link').addEventListener('click', async () => {
    if (await copyText(link)) toast('Bağlantı kopyalandı.');
  });
  $('#track-link').addEventListener('focus', (e) => e.target.select());
}

boot();
