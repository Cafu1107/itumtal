// İTÜ MTAL ziyaret başvuru API'si — Cloudflare Worker + D1.
//
// Public:  GET  /api/config                      settings + open days for the form calendar
//          POST /api/applications                new visit application
//          GET  /api/track/:token                status for the teacher's tracking link
//          POST /api/track/:token/cancel         teacher cancels
// Panel:   POST /api/auth/login | /api/auth/logout | /api/auth/password, GET /api/auth/me
//          GET  /api/admin/applications          all applications
//          GET  /api/admin/applications/:id      one application + its history
//          PATCH /api/admin/applications/:id     approve / reject / cancel / reopen / notes
//          DELETE /api/admin/applications/:id
//          GET  /api/admin/export.csv
//          GET|PUT /api/admin/settings, POST|DELETE /api/admin/closed-days
//          GET|POST /api/admin/users, PATCH|DELETE /api/admin/users/:id   (admin role only)

import {
  STATUSES, DISTRICTS, GRADES, TIME_PREFS, ROLES_TEACHER,
  todayTR, isISODate, addDays, isTime, parseSettings, validateSettings, dayBlock, remainingFor,
  validateApplication, clean, randomCode, randomToken, sha256, hashPassword, verifyPassword,
  validatePassword, toCSV, checkTurnstile,
} from './lib.mjs';

const SESSION_HOURS = 12;
const MAX_PENDING_PER_PHONE = 3;
// Abuse limits, enforced inside the INSERT so parallel bursts can't race past them.
const IP_MAX_10MIN = 3;
const IP_MAX_DAY = 8;
const GLOBAL_MAX_10MIN = 40;
const LOCK_AFTER_FAILS = 5;
const LOCK_MINUTES = 15;

const BLOCK_MESSAGES = {
  past: 'Bu tarih için başvuru süresi geçti.',
  far: 'Bu tarih henüz başvuruya açık değil.',
  season: 'Bu tarih tanıtım dönemi dışında.',
  weekday: 'Bu gün ziyaret kabul edilmiyor.',
  closed: 'Bu gün okul ziyarete kapalı.',
};

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) res = json({ error: err.message, ...err.extra }, err.status);
      else {
        console.error(err && err.stack || err);
        res = json({ error: 'Sunucuda bir hata oluştu. Lütfen biraz sonra tekrar deneyin.' }, 500);
      }
    }
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'no-referrer');
    if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
    return new Response(res.body, { status: res.status, headers: h });
  },
};

// ---------- routing ----------

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;
  let mm;

  if (p === '/' || p === '/api') return json({ ok: true, service: 'itumtal-ziyaret' });

  if (p === '/api/config' && m === 'GET') {
    await limit(env.LIMIT_READ, request, 'read', 120);
    return getConfig(env);
  }
  if (p === '/api/applications' && m === 'POST') {
    await limit(env.LIMIT_WRITE, request, 'write', 10);
    return createApplication(request, env);
  }
  if ((mm = p.match(/^\/api\/track\/([A-Za-z0-9_-]{20,64})$/)) && m === 'GET') {
    await limit(env.LIMIT_READ, request, 'read', 120);
    return trackApplication(env, mm[1]);
  }
  if ((mm = p.match(/^\/api\/track\/([A-Za-z0-9_-]{20,64})\/cancel$/)) && m === 'POST') {
    await limit(env.LIMIT_WRITE, request, 'write', 10);
    return teacherCancel(env, mm[1]);
  }

  if (p === '/api/auth/login' && m === 'POST') {
    await limit(env.LIMIT_LOGIN, request, 'login', 10);
    return login(request, env);
  }

  if (!p.startsWith('/api/auth/') && !p.startsWith('/api/admin/')) throw new HttpError(404, 'Bulunamadı.');

  const user = await requireUser(request, env);
  await limit(env.LIMIT_ADMIN, request, 'admin', 300);

  if (p === '/api/auth/me' && m === 'GET') return json({ user: publicUser(user) });
  if (p === '/api/auth/logout' && m === 'POST') return logout(request, env);
  if (p === '/api/auth/password' && m === 'POST') return changeOwnPassword(request, env, user);

  if (p === '/api/admin/applications' && m === 'GET') return listApplications(env);
  if (p === '/api/admin/export.csv' && m === 'GET') return exportCSV(env);
  if ((mm = p.match(/^\/api\/admin\/applications\/(\d+)$/))) {
    const id = Number(mm[1]);
    if (m === 'GET') return getApplication(env, id);
    if (m === 'PATCH') return updateApplication(request, env, user, id);
    if (m === 'DELETE') return deleteApplication(env, id);
  }
  if (p === '/api/admin/settings' && m === 'GET') return getAdminSettings(env);
  if (p === '/api/admin/settings' && m === 'PUT') return putSettings(request, env);
  if (p === '/api/admin/closed-days' && m === 'POST') return addClosedDay(request, env);
  if (p === '/api/admin/blocked-ips' && m === 'GET') return listBlocked(env);
  if (p === '/api/admin/blocked-ips' && m === 'POST') return blockIP(request, env, user);
  if ((mm = p.match(/^\/api\/admin\/blocked-ips\/([^/]{2,140})$/)) && m === 'DELETE') return unblockIP(env, decodeURIComponent(mm[1]));
  if ((mm = p.match(/^\/api\/admin\/closed-days\/(\d{4}-\d{2}-\d{2})$/)) && m === 'DELETE') return removeClosedDay(env, mm[1]);

  if (p.startsWith('/api/admin/users')) {
    if (user.role !== 'admin') throw new HttpError(403, 'Bu işlem için yönetici hesabı gerekiyor.');
    if (p === '/api/admin/users' && m === 'GET') return listUsers(env);
    if (p === '/api/admin/users' && m === 'POST') return createUser(request, env);
    if ((mm = p.match(/^\/api\/admin\/users\/(\d+)$/))) {
      if (m === 'PATCH') return updateUser(request, env, user, Number(mm[1]));
      if (m === 'DELETE') return deleteUser(env, user, Number(mm[1]));
    }
  }
  throw new HttpError(404, 'Bulunamadı.');
}

// ---------- helpers ----------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { Vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

async function readJSON(request, maxBytes = 16384) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) throw new HttpError(415, 'JSON bekleniyor.');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'İstek çok büyük.');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Geçersiz istek.'); }
}

const nowISO = () => new Date().toISOString();
const clientIP = (request) => request.headers.get('CF-Connecting-IP') || 'local';

// Cloudflare rate-limit bindings when present, plus a per-isolate fallback counter.
const memoryBuckets = new Map();
async function limit(binding, request, name, perMinute) {
  const key = `${name}:${clientIP(request)}`;
  if (binding) {
    const { success } = await binding.limit({ key });
    if (!success) throw new HttpError(429, 'Çok fazla istek gönderildi. Lütfen bir dakika sonra tekrar deneyin.');
    return;
  }
  const now = Date.now();
  const b = memoryBuckets.get(key);
  if (!b || now - b.start > 60000) { memoryBuckets.set(key, { start: now, n: 1 }); return; }
  if (++b.n > perMinute) throw new HttpError(429, 'Çok fazla istek gönderildi. Lütfen bir dakika sonra tekrar deneyin.');
}

async function loadSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  return parseSettings(results);
}

async function loadClosed(env) {
  const { results } = await env.DB.prepare('SELECT date, reason FROM closed_days').all();
  return new Map(results.map((r) => [r.date, r.reason]));
}

/** Approved student totals per visit date (optionally excluding one application). */
async function loadUsed(env, from, to, excludeId = 0) {
  const { results } = await env.DB.prepare(
    `SELECT visit_date AS d, SUM(student_count) AS n FROM applications
     WHERE status = 'approved' AND visit_date BETWEEN ?1 AND ?2 AND id != ?3 GROUP BY visit_date`,
  ).bind(from, to, excludeId).all();
  return new Map(results.map((r) => [r.d, Number(r.n)]));
}

async function logEvent(env, appId, actor, action, detail = '') {
  await env.DB.prepare('INSERT INTO events (app_id, at, actor, action, detail) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(appId, nowISO(), actor, action, detail).run();
}

function rowToApp(r) {
  return { ...r, preferred_dates: safeParse(r.preferred_dates, []) };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ---------- public ----------

async function getConfig(env) {
  const settings = await loadSettings(env);
  const closed = await loadClosed(env);
  const today = todayTR();
  const from = addDays(today, settings.min_lead_days);
  const to = addDays(today, settings.max_ahead_days);
  const used = await loadUsed(env, from, to);
  const days = {};
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (dayBlock(d, settings, closed, today)) continue;
    days[d] = remainingFor(d, settings, used);
  }
  return json({
    today,
    booking_open: settings.booking_open,
    daily_capacity: settings.daily_capacity,
    weekdays: settings.weekdays,
    first_day: from,
    last_day: settings.season_end && settings.season_end < to ? settings.season_end : to,
    notice: settings.notice,
    days, // open days only: date -> remaining seats
    options: { districts: DISTRICTS, grades: GRADES, time_prefs: TIME_PREFS, roles: ROLES_TEACHER },
  }, 200, { 'Cache-Control': 'public, max-age=30' });
}

async function createApplication(request, env) {
  const body = await readJSON(request);
  const ip = clientIP(request);
  // Honeypot + minimum fill time: bots fill every field and submit instantly.
  if (body.website) reject(ip, 'honeypot', 400, 'Geçersiz istek.');
  if (typeof body.started_at !== 'number' || Date.now() - body.started_at < 4000) {
    reject(ip, 'too_fast', 400, 'Form çok hızlı gönderildi. Lütfen bilgileri kontrol edip tekrar deneyin.');
  }
  if (await env.DB.prepare('SELECT 1 FROM blocked_ips WHERE ip = ?1').bind(ip).first()) {
    reject(ip, 'blocked', 403, BLOCKED_MESSAGE);
  }
  const human = await verifyTurnstile(env, body.turnstile, ip);
  if (human !== true) reject(ip, `turnstile_${human}`, 400, TURNSTILE_MESSAGE);

  const settings = await loadSettings(env);
  if (!settings.booking_open) throw new HttpError(409, 'Ziyaret başvuruları şu anda kapalı.');

  const closed = await loadClosed(env);
  const today = todayTR();
  const used = await loadUsed(env, today, addDays(today, settings.max_ahead_days + 1));
  const check = (d, count) => {
    const block = dayBlock(d, settings, closed, today);
    if (block) return BLOCK_MESSAGES[block];
    const left = remainingFor(d, settings, used);
    if (Number.isInteger(count) && count > left) return `${formatDateTR(d)} için ${left} kişilik yer kaldı. Başka bir gün seçin.`;
    return '';
  };
  const { ok, value: v, errors } = validateApplication(body, settings, check);
  if (!ok) throw new HttpError(422, 'Lütfen işaretli alanları kontrol edin.', { fields: errors });

  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE phone = ?1 AND status = 'pending'")
    .bind(v.phone).first();
  if (pending.n >= MAX_PENDING_PER_PHONE) {
    throw new HttpError(429, 'Bu telefon numarasıyla bekleyen başvurularınız var. Rehberlik servisi sizinle iletişime geçecek.');
  }

  const token = randomToken(24);
  const now = nowISO();
  const since10 = new Date(Date.now() - 10 * 60000).toISOString();
  const sinceDay = new Date(Date.now() - 24 * 3600000).toISOString();
  let code, id;
  for (let attempt = 0; attempt < 5; attempt++) {
    code = randomCode(6);
    try {
      // One statement is one atomic step in D1: the limits are checked and the row written together.
      const r = await env.DB.prepare(
        `INSERT INTO applications (code, token, school_name, district, teacher_name, teacher_role, phone, email,
          student_count, escort_count, grade, time_pref, preferred_dates, note, ip, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?16, ?15, ?15
         WHERE NOT EXISTS (SELECT 1 FROM blocked_ips WHERE ip = ?16)
           AND (SELECT COUNT(*) FROM applications WHERE ip = ?16 AND created_at > ?17) < ?19
           AND (SELECT COUNT(*) FROM applications WHERE ip = ?16 AND created_at > ?18) < ?20
           AND (SELECT COUNT(*) FROM applications WHERE created_at > ?17) < ?21`,
      ).bind(code, token, v.school_name, v.district, v.teacher_name, v.teacher_role, v.phone, v.email,
        v.student_count, v.escort_count, v.grade, v.time_pref, JSON.stringify(v.preferred_dates), v.note, now,
        ip, since10, sinceDay, IP_MAX_10MIN, IP_MAX_DAY, GLOBAL_MAX_10MIN).run();
      if (!r.meta.changes) await rejectLimited(env, ip, since10, sinceDay);
      id = r.meta.last_row_id;
      break;
    } catch (err) {
      if (!String(err).includes('UNIQUE') || attempt === 4) throw err;
    }
  }
  console.log(JSON.stringify({ evt: 'application', result: 'created', ip, code }));
  await logEvent(env, id, 'öğretmen', 'created', v.preferred_dates.join(', '));
  return json({ ok: true, code, token }, 201);
}

const TURNSTILE_MESSAGE = 'Robot doğrulaması tamamlanamadı. Sayfayı yenileyip tekrar deneyin.';

/** Skipped (true) while TURNSTILE_SECRET is not configured, so the site keeps working without it. */
const verifyTurnstile = (env, token, ip) => checkTurnstile(env.TURNSTILE_SECRET, token, ip);

const BLOCKED_MESSAGE = 'Bu bağlantıdan başvuru kabul edilmiyor. Lütfen okulu 0212 261 24 20 numarasından arayın.';

function reject(ip, reason, status, message) {
  console.log(JSON.stringify({ evt: 'application', result: reason, ip }));
  throw new HttpError(status, message);
}

/** Works out which limit stopped the guarded INSERT, for an honest message. Always throws. */
async function rejectLimited(env, ip, since10, sinceDay) {
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM applications WHERE ip = ?1 AND created_at > ?2) AS ip10,
            (SELECT COUNT(*) FROM applications WHERE ip = ?1 AND created_at > ?3) AS ipDay,
            EXISTS (SELECT 1 FROM blocked_ips WHERE ip = ?1) AS blocked`,
  ).bind(ip, since10, sinceDay).first();
  if (r.blocked) reject(ip, 'blocked', 403, BLOCKED_MESSAGE);
  if (r.ip10 >= IP_MAX_10MIN) reject(ip, 'ip_10min', 429, 'Kısa sürede çok fazla başvuru gönderildi. Lütfen biraz sonra tekrar deneyin.');
  if (r.ipDay >= IP_MAX_DAY) reject(ip, 'ip_day', 429, 'Bu bağlantıdan bugün çok fazla başvuru yapıldı. Yarın tekrar deneyin ya da okulu arayın.');
  reject(ip, 'global_10min', 503, 'Şu anda çok yoğun başvuru alıyoruz. Lütfen birkaç dakika sonra tekrar deneyin.');
}

async function findByToken(env, token) {
  const row = await env.DB.prepare('SELECT * FROM applications WHERE token = ?1').bind(token).first();
  if (!row) throw new HttpError(404, 'Başvuru bulunamadı. Bağlantıyı eksiksiz kopyaladığınızdan emin olun.');
  return row;
}

async function trackApplication(env, token) {
  const r = await findByToken(env, token);
  const today = todayTR();
  return json({
    code: r.code,
    status: r.status,
    school_name: r.school_name,
    teacher_name: r.teacher_name,
    student_count: r.student_count,
    preferred_dates: safeParse(r.preferred_dates, []),
    time_pref: r.time_pref,
    visit_date: r.status === 'approved' ? r.visit_date : null,
    visit_time: r.status === 'approved' ? r.visit_time : null,
    message: r.admin_message,
    cancelled_by: r.cancelled_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    can_cancel: r.status === 'pending' || (r.status === 'approved' && r.visit_date >= today),
  });
}

async function teacherCancel(env, token) {
  const r = await findByToken(env, token);
  if (r.status === 'cancelled') return json({ ok: true });
  if (r.status === 'rejected') throw new HttpError(409, 'Bu başvuru zaten sonuçlandı.');
  if (r.status === 'approved' && r.visit_date < todayTR()) throw new HttpError(409, 'Ziyaret tarihi geçtiği için iptal edilemiyor.');
  await env.DB.prepare("UPDATE applications SET status = 'cancelled', cancelled_by = 'teacher', updated_at = ?1 WHERE id = ?2")
    .bind(nowISO(), r.id).run();
  await logEvent(env, r.id, 'öğretmen', 'cancelled');
  return json({ ok: true });
}

// ---------- auth ----------

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
}

async function login(request, env) {
  const body = await readJSON(request, 2048);
  const username = clean(body.username, 40).toLocaleLowerCase('tr');
  const password = String(body.password || '');
  const human = await verifyTurnstile(env, body.turnstile, clientIP(request));
  if (human !== true) {
    console.log(JSON.stringify({ evt: 'login', result: `turnstile_${human}`, ip: clientIP(request), username }));
    throw new HttpError(400, TURNSTILE_MESSAGE);
  }
  if (!username || !password || password.length > 128) throw new HttpError(401, 'Kullanıcı adı veya şifre hatalı.');

  const u = await env.DB.prepare('SELECT * FROM users WHERE username = ?1').bind(username).first();
  const now = nowISO();
  if (u && u.locked_until && u.locked_until > now) {
    throw new HttpError(429, 'Çok fazla hatalı deneme yapıldı. Lütfen 15 dakika sonra tekrar deneyin.');
  }
  // Hash even for unknown users so response time doesn't reveal which usernames exist.
  const okPw = await verifyPassword(password, u ? u.pass_hash : 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  if (!u || !okPw) {
    if (u) {
      const fails = u.failed + 1;
      const lock = fails >= LOCK_AFTER_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
      await env.DB.prepare('UPDATE users SET failed = ?1, locked_until = ?2 WHERE id = ?3')
        .bind(lock ? 0 : fails, lock, u.id).run();
    }
    console.log(JSON.stringify({ evt: 'login', result: 'bad_password', ip: clientIP(request), username }));
    throw new HttpError(401, 'Kullanıcı adı veya şifre hatalı.');
  }

  console.log(JSON.stringify({ evt: 'login', result: 'ok', ip: clientIP(request), username }));
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_HOURS * 3600000).toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(await sha256(token), u.id, expires, now),
    env.DB.prepare('UPDATE users SET failed = 0, locked_until = NULL, last_login = ?1 WHERE id = ?2').bind(now, u.id),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now),
  ]);
  return json({ token, expires_at: expires, user: publicUser(u) });
}

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer ([A-Za-z0-9_-]{30,64})$/);
  return m ? m[1] : null;
}

async function requireUser(request, env) {
  const token = bearer(request);
  if (!token) throw new HttpError(401, 'Oturum açmanız gerekiyor.');
  const u = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
  ).bind(await sha256(token), nowISO()).first();
  if (!u) throw new HttpError(401, 'Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın.');
  return u;
}

async function logout(request, env) {
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256(bearer(request))).run();
  return json({ ok: true });
}

async function changeOwnPassword(request, env, user) {
  const body = await readJSON(request, 2048);
  if (!(await verifyPassword(String(body.current || ''), user.pass_hash))) {
    throw new HttpError(400, 'Mevcut şifre hatalı.', { fields: { current: 'Mevcut şifre hatalı.' } });
  }
  const err = validatePassword(body.next);
  if (err) throw new HttpError(422, err, { fields: { next: err } });
  const keep = await sha256(bearer(request));
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pass_hash = ?1 WHERE id = ?2').bind(await hashPassword(body.next), user.id),
    // sign out every other device
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2').bind(user.id, keep),
  ]);
  return json({ ok: true });
}

// ---------- panel: applications ----------

async function listApplications(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, code, token, ip, status, school_name, district, teacher_name, teacher_role, phone, email, student_count,
            escort_count, grade, time_pref, preferred_dates, note, visit_date, visit_time, admin_message,
            internal_note, cancelled_by, created_at, updated_at
     FROM applications ORDER BY created_at DESC LIMIT 5000`,
  ).all();
  return json({ applications: results.map(rowToApp), today: todayTR() });
}

async function getApplication(env, id) {
  const r = await env.DB.prepare('SELECT * FROM applications WHERE id = ?1').bind(id).first();
  if (!r) throw new HttpError(404, 'Başvuru bulunamadı.');
  const { results } = await env.DB.prepare('SELECT at, actor, action, detail FROM events WHERE app_id = ?1 ORDER BY id').bind(id).all();
  return json({ application: rowToApp(r), events: results });
}

async function updateApplication(request, env, user, id) {
  const body = await readJSON(request);
  const r = await env.DB.prepare('SELECT * FROM applications WHERE id = ?1').bind(id).first();
  if (!r) throw new HttpError(404, 'Başvuru bulunamadı.');
  const now = nowISO();
  const actor = user.username;
  const action = body.action;

  if (action === 'approve') {
    const date = String(body.visit_date || '');
    const time = String(body.visit_time || '');
    const fields = {};
    if (!isISODate(date)) fields.visit_date = 'Ziyaret tarihini seçin.';
    if (!isTime(time)) fields.visit_time = 'Saati SS:DD biçiminde girin (örn. 10:30).';
    if (Object.keys(fields).length) throw new HttpError(422, 'Tarih ve saat gerekli.', { fields });

    const settings = await loadSettings(env);
    const used = (await loadUsed(env, date, date, id)).get(date) || 0;
    if (used + r.student_count > settings.daily_capacity && body.force !== true) {
      throw new HttpError(409, 'Bu gün için kontenjan aşılıyor.', {
        code: 'capacity', used, capacity: settings.daily_capacity, adding: r.student_count,
      });
    }
    const message = clean(body.admin_message ?? r.admin_message, 600, true);
    await env.DB.prepare(
      `UPDATE applications SET status = 'approved', visit_date = ?1, visit_time = ?2, admin_message = ?3,
       cancelled_by = NULL, updated_at = ?4 WHERE id = ?5`,
    ).bind(date, time, message, now, id).run();
    await logEvent(env, id, actor, r.status === 'approved' ? 'rescheduled' : 'approved', `${date} ${time}`);
  } else if (action === 'reject') {
    const message = clean(body.admin_message ?? '', 600, true);
    await env.DB.prepare(
      "UPDATE applications SET status = 'rejected', admin_message = ?1, visit_date = NULL, visit_time = NULL, updated_at = ?2 WHERE id = ?3",
    ).bind(message, now, id).run();
    await logEvent(env, id, actor, 'rejected', message);
  } else if (action === 'cancel') {
    const message = clean(body.admin_message ?? r.admin_message, 600, true);
    await env.DB.prepare(
      "UPDATE applications SET status = 'cancelled', cancelled_by = 'school', admin_message = ?1, updated_at = ?2 WHERE id = ?3",
    ).bind(message, now, id).run();
    await logEvent(env, id, actor, 'cancelled', message);
  } else if (action === 'reopen') {
    await env.DB.prepare(
      "UPDATE applications SET status = 'pending', visit_date = NULL, visit_time = NULL, cancelled_by = NULL, updated_at = ?1 WHERE id = ?2",
    ).bind(now, id).run();
    await logEvent(env, id, actor, 'reopened');
  } else if (action === 'notes') {
    const sets = [];
    const vals = [];
    if ('internal_note' in body) { sets.push(`internal_note = ?${vals.length + 1}`); vals.push(clean(body.internal_note, 2000, true)); }
    if ('admin_message' in body) { sets.push(`admin_message = ?${vals.length + 1}`); vals.push(clean(body.admin_message, 600, true)); }
    if (!sets.length) throw new HttpError(400, 'Değişiklik yok.');
    vals.push(now, id);
    await env.DB.prepare(`UPDATE applications SET ${sets.join(', ')}, updated_at = ?${vals.length - 1} WHERE id = ?${vals.length}`)
      .bind(...vals).run();
  } else {
    throw new HttpError(400, 'Bilinmeyen işlem.');
  }
  return getApplication(env, id);
}

async function deleteApplication(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM events WHERE app_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM applications WHERE id = ?1').bind(id),
  ]);
  return json({ ok: true });
}

const STATUS_TR = { pending: 'Bekliyor', approved: 'Onaylandı', rejected: 'Reddedildi', cancelled: 'İptal' };

async function exportCSV(env) {
  const { results } = await env.DB.prepare('SELECT * FROM applications ORDER BY created_at').all();
  const rows = results.map(rowToApp);
  const csv = toCSV(rows, [
    { label: 'Kod', get: (r) => r.code },
    { label: 'Durum', get: (r) => STATUS_TR[r.status] },
    { label: 'Ziyaret tarihi', get: (r) => r.visit_date || '' },
    { label: 'Saat', get: (r) => r.visit_time || '' },
    { label: 'Okul', get: (r) => r.school_name },
    { label: 'İlçe', get: (r) => r.district },
    { label: 'Öğretmen', get: (r) => r.teacher_name },
    { label: 'Görevi', get: (r) => r.teacher_role },
    { label: 'Telefon', get: (r) => r.phone },
    { label: 'E-posta', get: (r) => r.email },
    { label: 'Öğrenci', get: (r) => r.student_count },
    { label: 'Refakatçi öğretmen', get: (r) => r.escort_count },
    { label: 'Sınıf', get: (r) => r.grade },
    { label: 'Saat tercihi', get: (r) => r.time_pref },
    { label: 'Tercih edilen tarihler', get: (r) => r.preferred_dates.join(', ') },
    { label: 'Not', get: (r) => r.note },
    { label: 'Öğretmene mesaj', get: (r) => r.admin_message },
    { label: 'İç not', get: (r) => r.internal_note },
    { label: 'Başvuru zamanı', get: (r) => r.created_at },
    { label: 'IP', get: (r) => r.ip || '' },
  ]);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ziyaret-basvurulari-${todayTR()}.csv"`,
    },
  });
}

// ---------- panel: settings ----------

async function getAdminSettings(env) {
  const settings = await loadSettings(env);
  const { results } = await env.DB.prepare('SELECT date, reason FROM closed_days ORDER BY date').all();
  return json({ settings, closed_days: results, today: todayTR() });
}

async function putSettings(request, env) {
  const body = await readJSON(request);
  const { ok, value, errors } = validateSettings(body);
  if (!ok) throw new HttpError(422, 'Lütfen işaretli alanları kontrol edin.', { fields: errors });
  const stmts = Object.entries(value).map(([k, v]) =>
    env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(k, JSON.stringify(v)));
  if (stmts.length) await env.DB.batch(stmts);
  return getAdminSettings(env);
}

async function addClosedDay(request, env) {
  const body = await readJSON(request);
  const from = String(body.date || '');
  const to = String(body.until || from);
  if (!isISODate(from) || !isISODate(to) || to < from) throw new HttpError(422, 'Geçerli bir tarih seçin.', { fields: { date: 'Geçerli bir tarih seçin.' } });
  const reason = clean(body.reason, 80);
  const stmts = [];
  for (let d = from; d <= to && stmts.length < 120; d = addDays(d, 1)) {
    stmts.push(env.DB.prepare('INSERT INTO closed_days (date, reason) VALUES (?1, ?2) ON CONFLICT(date) DO UPDATE SET reason = excluded.reason').bind(d, reason));
  }
  await env.DB.batch(stmts);
  return getAdminSettings(env);
}

async function removeClosedDay(env, date) {
  await env.DB.prepare('DELETE FROM closed_days WHERE date = ?1').bind(date).run();
  return getAdminSettings(env);
}

// ---------- panel: blocked IPs ----------

async function listBlocked(env) {
  const { results } = await env.DB.prepare(
    `SELECT b.ip, b.reason, b.created_by, b.created_at,
            (SELECT COUNT(*) FROM applications a WHERE a.ip = b.ip) AS applications
     FROM blocked_ips b ORDER BY b.created_at DESC`,
  ).all();
  return json({ blocked: results });
}

function isIP(s) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(s) || (/^[0-9a-f:]+$/i.test(s) && s.includes(':') && s.length <= 45);
}

async function blockIP(request, env, user) {
  const body = await readJSON(request, 2048);
  const ip = clean(body.ip, 64).toLowerCase();
  if (!isIP(ip)) throw new HttpError(422, 'Geçerli bir IP adresi yazın.', { fields: { ip: 'Geçerli bir IP adresi yazın.' } });
  const stmts = [
    env.DB.prepare(`INSERT INTO blocked_ips (ip, reason, created_by, created_at) VALUES (?1, ?2, ?3, ?4)
                    ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason`)
      .bind(ip, clean(body.reason, 120), user.username, nowISO()),
  ];
  let deleted = 0;
  if (body.delete_pending === true) {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE ip = ?1 AND status = 'pending'").bind(ip).first();
    deleted = r.n;
    stmts.push(
      env.DB.prepare("DELETE FROM events WHERE app_id IN (SELECT id FROM applications WHERE ip = ?1 AND status = 'pending')").bind(ip),
      env.DB.prepare("DELETE FROM applications WHERE ip = ?1 AND status = 'pending'").bind(ip),
    );
  }
  await env.DB.batch(stmts);
  const { results } = await env.DB.prepare(
    `SELECT b.ip, b.reason, b.created_by, b.created_at,
            (SELECT COUNT(*) FROM applications a WHERE a.ip = b.ip) AS applications
     FROM blocked_ips b ORDER BY b.created_at DESC`,
  ).all();
  return json({ blocked: results, deleted });
}

async function unblockIP(env, ip) {
  await env.DB.prepare('DELETE FROM blocked_ips WHERE ip = ?1').bind(ip).run();
  return listBlocked(env);
}

// ---------- panel: users (admin only) ----------

async function listUsers(env) {
  const { results } = await env.DB.prepare('SELECT id, username, display_name, role, last_login, created_at FROM users ORDER BY id').all();
  return json({ users: results });
}

function validUsername(u) {
  return /^[a-z0-9._-]{3,32}$/.test(u);
}

async function createUser(request, env) {
  const body = await readJSON(request, 2048);
  const username = clean(body.username, 32).toLocaleLowerCase('tr');
  const display = clean(body.display_name, 60);
  const role = body.role === 'admin' ? 'admin' : 'staff';
  const fields = {};
  if (!validUsername(username)) fields.username = 'Küçük harf, rakam, nokta veya tire kullanın (3-32 karakter, Türkçe karakter olmadan).';
  if (display.length < 2) fields.display_name = 'Görünen adı yazın.';
  const pwErr = validatePassword(body.password);
  if (pwErr) fields.password = pwErr;
  if (Object.keys(fields).length) throw new HttpError(422, 'Lütfen işaretli alanları kontrol edin.', { fields });
  try {
    await env.DB.prepare('INSERT INTO users (username, display_name, role, pass_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(username, display, role, await hashPassword(body.password), nowISO()).run();
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new HttpError(409, 'Bu kullanıcı adı zaten var.', { fields: { username: 'Bu kullanıcı adı zaten var.' } });
    throw err;
  }
  return listUsers(env);
}

async function updateUser(request, env, me, id) {
  const body = await readJSON(request, 2048);
  const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
  if (!target) throw new HttpError(404, 'Kullanıcı bulunamadı.');
  const stmts = [];
  if ('password' in body) {
    const err = validatePassword(body.password);
    if (err) throw new HttpError(422, err, { fields: { password: err } });
    stmts.push(env.DB.prepare('UPDATE users SET pass_hash = ?1, failed = 0, locked_until = NULL WHERE id = ?2').bind(await hashPassword(body.password), id));
    if (id !== me.id) stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id));
  }
  if ('display_name' in body) {
    const d = clean(body.display_name, 60);
    if (d.length < 2) throw new HttpError(422, 'Görünen adı yazın.', { fields: { display_name: 'Görünen adı yazın.' } });
    stmts.push(env.DB.prepare('UPDATE users SET display_name = ?1 WHERE id = ?2').bind(d, id));
  }
  if ('role' in body && id !== me.id) {
    stmts.push(env.DB.prepare('UPDATE users SET role = ?1 WHERE id = ?2').bind(body.role === 'admin' ? 'admin' : 'staff', id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return listUsers(env);
}

async function deleteUser(env, me, id) {
  if (id === me.id) throw new HttpError(400, 'Kendi hesabınızı silemezsiniz.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id),
  ]);
  return listUsers(env);
}

// ---------- misc ----------

const MONTHS_TR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
function formatDateTR(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS_TR[m - 1]}`;
}

export { STATUSES };
