// End-to-end check against a running Worker (default: local `npm run dev`).
//   ADMIN_PASSWORD=... STAFF_PASSWORD=... node test/api.integration.mjs [baseUrl]
// Creates real rows: run it against the local database, not production.
import assert from 'node:assert/strict';

const B = process.argv[2] || 'http://127.0.0.1:8787';
const ADMIN_PW = process.env.ADMIN_PASSWORD;
const STAFF_PW = process.env.STAFF_PASSWORD;
if (!ADMIN_PW || !STAFF_PW) { console.error('ADMIN_PASSWORD ve STAFF_PASSWORD gerekli.'); process.exit(1); }

async function call(method, path, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  for (;;) {
    res = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status !== 429 || path === '/api/auth/login') break;
    console.log('  (istek sınırı — 30 sn bekleniyor)');
    await new Promise((ok) => setTimeout(ok, 30000));
  }
  const type = res.headers.get('Content-Type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
}

const step = (name) => console.log('•', name);

const admin = (await call('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW })).data.token;
assert.ok(admin, 'admin login');
await call('PUT', '/api/admin/settings', { daily_capacity: 120, booking_open: true, notice: 'Kasım ayı yoğun geçiyor, erken başvurun.', weekdays: [1, 2, 3, 4, 5] }, admin);

step('config lists open days with remaining seats');
let cfg = (await call('GET', '/api/config')).data;
const days = Object.keys(cfg.days);
assert.ok(days.length > 20);
assert.equal(cfg.notice, 'Kasım ayı yoğun geçiyor, erken başvurun.');
const [d1, d2, d3] = days.slice(-3); // far-future days are least likely to hold earlier test rows
for (const d of [d1, d2]) await call('DELETE', `/api/admin/closed-days/${d}`, undefined, admin);
// Start clean: remove rows left behind by earlier runs of this script.
for (const a of (await call('GET', '/api/admin/applications', undefined, admin)).data.applications) {
  if (a.school_name === 'Levent Ortaokulu') await call('DELETE', `/api/admin/applications/${a.id}`, undefined, admin);
}

step('validation errors come back per field');
let r = await call('POST', '/api/applications', { school_name: 'a', kvkk: false });
assert.equal(r.status, 422);
assert.ok(r.data.fields.school_name && r.data.fields.phone && r.data.fields.kvkk);

const base = {
  school_name: 'Levent Ortaokulu', district: 'Beşiktaş', teacher_name: 'Ayşe Yılmaz', teacher_role: 'Rehber öğretmen',
  phone: '0532 123 45 67', email: 'ayse@okul.k12.tr', student_count: 80, escort_count: 3, grade: '8. sınıf',
  time_pref: 'Sabah', preferred_dates: [d1, d2], note: 'Bir öğrencimiz tekerlekli sandalye kullanıyor.', kvkk: true,
};

step('honeypot is rejected');
assert.equal((await call('POST', '/api/applications', { ...base, website: 'x' })).status, 400);

step('valid application returns code + token');
r = await call('POST', '/api/applications', base);
assert.equal(r.status, 201, JSON.stringify(r.data));
const { token, code } = r.data;
assert.match(code, /^[A-Z2-9]{6}$/);

step('tracking link shows pending');
r = await call('GET', `/api/track/${token}`);
assert.equal(r.data.status, 'pending');
assert.equal(r.data.school_name, 'Levent Ortaokulu');
assert.equal(r.data.visit_date, null);

step('panel rejects missing / bad tokens');
assert.equal((await call('GET', '/api/admin/applications')).status, 401);
assert.equal((await call('GET', '/api/admin/applications', undefined, 'x'.repeat(43))).status, 401);
assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'yanlis' })).status, 401);

const list = (await call('GET', '/api/admin/applications', undefined, admin)).data.applications;
const app = list.find((a) => a.code === code);
assert.ok(app);
assert.equal(app.phone, '05321234567');

step('approve fills the day');
r = await call('PATCH', `/api/admin/applications/${app.id}`, { action: 'approve', visit_date: d1, visit_time: '10:30', admin_message: 'Ana girişte buluşalım.' }, admin);
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.application.status, 'approved');
assert.equal((await call('GET', '/api/config')).data.days[d1], 40);

step('a group that no longer fits is refused for that day');
r = await call('POST', '/api/applications', { ...base, phone: '0533 000 00 00', student_count: 60, preferred_dates: [d1] });
assert.equal(r.status, 422);
assert.match(r.data.fields.preferred_dates, /40 kişilik yer kaldı/);

step('approving over capacity needs force');
r = await call('POST', '/api/applications', { ...base, phone: '0533 000 00 01', student_count: 60, preferred_dates: [d2] });
assert.equal(r.status, 201);
const second = (await call('GET', '/api/admin/applications', undefined, admin)).data.applications.find((a) => a.code === r.data.code);
r = await call('PATCH', `/api/admin/applications/${second.id}`, { action: 'approve', visit_date: d1, visit_time: '13:30' }, admin);
assert.equal(r.status, 409);
assert.equal(r.data.code, 'capacity');
assert.equal(r.data.used, 80);
r = await call('PATCH', `/api/admin/applications/${second.id}`, { action: 'approve', visit_date: d1, visit_time: '13:30', force: true }, admin);
assert.equal(r.status, 200);
assert.equal((await call('GET', '/api/config')).data.days[d1], 0);
r = await call('PATCH', `/api/admin/applications/${second.id}`, { action: 'reject', admin_message: 'Bu dönem kontenjan doldu.' }, admin);
assert.equal(r.data.application.status, 'rejected');
assert.equal(r.data.events.at(-1).action, 'rejected');

step('teacher sees the approved date and message, then cancels');
r = await call('GET', `/api/track/${token}`);
assert.equal(r.data.status, 'approved');
assert.equal(r.data.visit_time, '10:30');
assert.equal(r.data.message, 'Ana girişte buluşalım.');
assert.equal((await call('POST', `/api/track/${token}/cancel`)).status, 200);
assert.equal((await call('GET', `/api/track/${token}`)).data.status, 'cancelled');
assert.equal((await call('GET', '/api/config')).data.days[d1], 120);

step('settings and closed days');
r = await call('PUT', '/api/admin/settings', { daily_capacity: 0 }, admin);
assert.equal(r.status, 422);
r = await call('POST', '/api/admin/closed-days', { date: d3, reason: 'Sınav haftası' }, admin);
assert.ok(r.data.closed_days.some((c) => c.date === d3 && c.reason === 'Sınav haftası'));
assert.ok(!((await call('GET', '/api/config')).data.days[d3] >= 0));
await call('DELETE', `/api/admin/closed-days/${d3}`, undefined, admin);

step('staff can work applications but not manage users');
const staff = (await call('POST', '/api/auth/login', { username: 'gulnihal', password: STAFF_PW })).data.token;
assert.ok(staff);
assert.equal((await call('GET', '/api/admin/applications', undefined, staff)).status, 200);
assert.equal((await call('GET', '/api/admin/users', undefined, staff)).status, 403);
assert.equal((await call('GET', '/api/admin/users', undefined, admin)).status, 200);

step('CSV export keeps Turkish text');
r = await call('GET', '/api/admin/export.csv', undefined, admin);
assert.ok(r.data.includes('Levent Ortaokulu') && r.data.includes('Beşiktaş'));

step('CORS only for allowed origins');
let res = await fetch(B + '/api/config', { headers: { Origin: 'http://localhost:5500' } });
assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5500');
res = await fetch(B + '/api/config', { headers: { Origin: 'https://evil.example' } });
assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);

step('logout ends the session');
await call('POST', '/api/auth/logout', undefined, staff);
assert.equal((await call('GET', '/api/auth/me', undefined, staff)).status, 401);

console.log('\nTüm API kontrolleri geçti.');
