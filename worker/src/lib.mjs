// Pure helpers shared by the Worker, the tests and scripts/seed-user.mjs.
// No D1 or Request objects in here, so everything can run under `node --test`.

export const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

export const DEFAULT_SETTINGS = {
  daily_capacity: 120,
  weekdays: [1, 2, 3, 4, 5], // ISO: 1 = Pazartesi … 7 = Pazar
  min_lead_days: 2,
  max_ahead_days: 120,
  booking_open: true,
  season_end: '', // YYYY-MM-DD, empty = no end
  notice: '',
};

export const DISTRICTS = [
  'Adalar', 'Arnavutköy', 'Ataşehir', 'Avcılar', 'Bağcılar', 'Bahçelievler', 'Bakırköy', 'Başakşehir',
  'Bayrampaşa', 'Beşiktaş', 'Beykoz', 'Beylikdüzü', 'Beyoğlu', 'Büyükçekmece', 'Çatalca', 'Çekmeköy',
  'Esenler', 'Esenyurt', 'Eyüpsultan', 'Fatih', 'Gaziosmanpaşa', 'Güngören', 'Kadıköy', 'Kağıthane',
  'Kartal', 'Küçükçekmece', 'Maltepe', 'Pendik', 'Sancaktepe', 'Sarıyer', 'Silivri', 'Sultanbeyli',
  'Sultangazi', 'Şile', 'Şişli', 'Tuzla', 'Ümraniye', 'Üsküdar', 'Zeytinburnu', 'İstanbul dışı',
];

export const GRADES = ['8. sınıf', '7. sınıf', 'Karma', 'Diğer'];
export const TIME_PREFS = ['Sabah', 'Öğleden sonra', 'Fark etmez'];
export const ROLES_TEACHER = ['Rehber öğretmen', 'Sınıf / branş öğretmeni', 'Okul idarecisi', 'Diğer'];

// ---------- dates (Türkiye is UTC+3 all year) ----------

const DAY_MS = 86400000;
const TR_OFFSET_MS = 3 * 3600000;

export function todayTR(now = Date.now()) {
  return new Date(now + TR_OFFSET_MS).toISOString().slice(0, 10);
}

export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(iso, n) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
}

export function isoWeekday(iso) {
  const d = new Date(iso + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
  return d === 0 ? 7 : d;
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
}

export function isTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

// ---------- settings ----------

export function parseSettings(rows) {
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const { key, value } of rows) {
    if (!(key in s)) continue;
    try { s[key] = JSON.parse(value); } catch { /* keep default */ }
  }
  return s;
}

export function validateSettings(input) {
  const out = {};
  const errors = {};
  if ('daily_capacity' in input) {
    const n = Number(input.daily_capacity);
    if (!Number.isInteger(n) || n < 1 || n > 2000) errors.daily_capacity = '1 ile 2000 arasında bir sayı girin.';
    else out.daily_capacity = n;
  }
  if ('weekdays' in input) {
    const w = Array.isArray(input.weekdays) ? [...new Set(input.weekdays.map(Number))].sort() : null;
    if (!w || !w.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) errors.weekdays = 'Geçersiz gün seçimi.';
    else out.weekdays = w;
  }
  if ('min_lead_days' in input) {
    const n = Number(input.min_lead_days);
    if (!Number.isInteger(n) || n < 0 || n > 60) errors.min_lead_days = '0 ile 60 arasında bir sayı girin.';
    else out.min_lead_days = n;
  }
  if ('max_ahead_days' in input) {
    const n = Number(input.max_ahead_days);
    if (!Number.isInteger(n) || n < 7 || n > 400) errors.max_ahead_days = '7 ile 400 arasında bir sayı girin.';
    else out.max_ahead_days = n;
  }
  if ('booking_open' in input) out.booking_open = Boolean(input.booking_open);
  if ('season_end' in input) {
    const v = String(input.season_end || '');
    if (v && !isISODate(v)) errors.season_end = 'Geçersiz tarih.';
    else out.season_end = v;
  }
  if ('notice' in input) {
    const v = clean(input.notice, 400, true);
    out.notice = v;
  }
  return { ok: Object.keys(errors).length === 0, value: out, errors };
}

// ---------- availability ----------

/**
 * Why a day can't be picked by a visiting teacher, or '' if it can.
 * `closed` is a Map/obj date -> reason.
 */
export function dayBlock(iso, settings, closed, today) {
  const lead = daysBetween(today, iso);
  if (lead < settings.min_lead_days) return 'past';
  if (lead > settings.max_ahead_days) return 'far';
  if (settings.season_end && iso > settings.season_end) return 'season';
  if (!settings.weekdays.includes(isoWeekday(iso))) return 'weekday';
  if (closed.has(iso)) return 'closed';
  return '';
}

export function remainingFor(iso, settings, used) {
  return Math.max(0, settings.daily_capacity - (used.get(iso) || 0));
}

// ---------- application validation ----------

export function clean(v, max, multiline = false) {
  let s = String(v ?? '').normalize('NFC');
  s = multiline ? s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  // strip control characters except newlines/tabs
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return s.trim().slice(0, max);
}

/** Normalises Turkish phone numbers to 05XXXXXXXXX (mobile) or 0XXXXXXXXXX (landline). */
export function normalizePhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.startsWith('0090')) d = d.slice(4);
  else if (d.startsWith('90') && d.length === 12) d = d.slice(2);
  if (d.length === 10) d = '0' + d;
  return /^0[2-5]\d{9}$/.test(d) ? d : null;
}

export function isEmail(v) {
  return typeof v === 'string' && v.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

/**
 * Validates a visit application. Returns { ok, value, errors } where errors maps a
 * field name to a Turkish message the form can show next to that field.
 * `checkDate(iso)` returns '' or an error message for a preferred date.
 */
export function validateApplication(body, settings, checkDate = () => '') {
  const errors = {};
  const v = {};
  const b = body && typeof body === 'object' ? body : {};

  v.school_name = clean(b.school_name, 120);
  if (v.school_name.length < 3) errors.school_name = 'Okulunuzun adını yazın.';

  v.district = clean(b.district, 40);
  if (!DISTRICTS.includes(v.district)) errors.district = 'İlçe seçin.';

  v.teacher_name = clean(b.teacher_name, 80);
  if (v.teacher_name.length < 3 || !/\p{L}/u.test(v.teacher_name)) errors.teacher_name = 'Adınızı ve soyadınızı yazın.';

  v.teacher_role = clean(b.teacher_role, 40);
  if (v.teacher_role && !ROLES_TEACHER.includes(v.teacher_role)) v.teacher_role = 'Diğer';

  v.phone = normalizePhone(b.phone);
  if (!v.phone) errors.phone = 'Geçerli bir telefon numarası yazın (örn. 0532 123 45 67).';

  v.email = clean(b.email, 160).toLowerCase();
  if (!isEmail(v.email)) errors.email = 'Geçerli bir e-posta adresi yazın.';

  v.student_count = Number(b.student_count);
  if (!Number.isInteger(v.student_count) || v.student_count < 1) errors.student_count = 'Öğrenci sayısını yazın.';
  else if (v.student_count > settings.daily_capacity) errors.student_count = `Bir günde en fazla ${settings.daily_capacity} öğrenci ağırlayabiliyoruz.`;

  v.escort_count = b.escort_count === '' || b.escort_count == null ? 0 : Number(b.escort_count);
  if (!Number.isInteger(v.escort_count) || v.escort_count < 0 || v.escort_count > 50) errors.escort_count = '0 ile 50 arasında bir sayı yazın.';

  v.grade = clean(b.grade, 20);
  if (!GRADES.includes(v.grade)) errors.grade = 'Sınıf düzeyini seçin.';

  v.time_pref = clean(b.time_pref, 20) || 'Fark etmez';
  if (!TIME_PREFS.includes(v.time_pref)) v.time_pref = 'Fark etmez';

  const dates = Array.isArray(b.preferred_dates) ? b.preferred_dates.map(String) : [];
  v.preferred_dates = [...new Set(dates)].slice(0, 3);
  if (dates.length > 3) errors.preferred_dates = 'En fazla 3 tarih seçebilirsiniz.';
  else if (v.preferred_dates.length === 0) errors.preferred_dates = 'Takvimden en az bir tarih seçin.';
  else {
    for (const d of v.preferred_dates) {
      const msg = isISODate(d) ? checkDate(d, v.student_count) : 'Geçersiz tarih.';
      if (msg) { errors.preferred_dates = msg; break; }
    }
  }

  v.note = clean(b.note, 600, true);

  if (b.kvkk !== true) errors.kvkk = 'Devam etmek için aydınlatma metnini onaylayın.';

  return { ok: Object.keys(errors).length === 0, value: v, errors };
}

// ---------- tokens & passwords ----------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function randomCode(len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 24) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64url(new Uint8Array(buf));
}

// Workers cap PBKDF2 at 100k iterations.
const PBKDF2_ITER = 100000;

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2' || !iter || !salt || !hash) return false;
  const got = await pbkdf2(password, fromB64url(salt), Number(iter));
  return timingSafeEqual(got, fromB64url(hash));
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Şifre en az 8 karakter olmalı.';
  if (pw.length > 128) return 'Şifre çok uzun.';
  return '';
}

// ---------- CSV ----------

export function toCSV(rows, columns) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[;"\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(';');
  const body = rows.map((r) => columns.map((c) => esc(c.get(r))).join(';'));
  return '﻿' + [head, ...body].join('\r\n');
}
