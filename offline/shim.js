// Offline demo runtime, injected at the top of every page bundle by offline/build.mjs.
//
// It runs the real API (worker/src/index.mjs) inside the page: requests to API_BASE are answered
// by worker.fetch() on an in-browser SQLite database (sql.js) that looks like Cloudflare D1.
// The database is saved in localStorage, so it is shared by all pages of the demo on this computer.
import worker from '../worker/src/index.mjs';
import { hashPassword, todayTR, addDays, isoWeekday } from '../worker/src/lib.mjs';
import m1 from '../worker/migrations/0001_init.sql';
import m2 from '../worker/migrations/0002_ip_block.sql';
import m3 from '../worker/migrations/0003_confirm_attendance.sql';
import { API_BASE, OFFLINE_DEMO } from '../site/assets/js/common.js';

const DB_KEY = 'itumtal.offline.db.v1';

// ---------- base64 <-> bytes ----------

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// ---------- a D1-shaped wrapper around sql.js ----------

const toSql = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...args) { return new Statement(this.db, this.sql, args.map(toSql)); }
  rows() {
    const st = this.db.prepare(this.sql);
    try {
      st.bind(this.params);
      const out = [];
      while (st.step()) out.push(st.getAsObject());
      return out;
    } finally { st.free(); }
  }
  async all() { return { success: true, results: this.rows(), meta: {} }; }
  async first(col) {
    const r = this.rows()[0];
    if (r === undefined) return null;
    return col ? r[col] : r;
  }
  async run() {
    const st = this.db.prepare(this.sql);
    try {
      st.bind(this.params);
      while (st.step()) { /* drain */ }
    } finally { st.free(); }
    const changes = this.db.getRowsModified();
    const id = this.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    return { success: true, meta: { changes, last_row_id: id } };
  }
}

function d1(db) {
  return {
    prepare: (sql) => new Statement(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

// ---------- storage ----------

function load() { try { return localStorage.getItem(DB_KEY); } catch { return null; } }
function save(db) {
  try { localStorage.setItem(DB_KEY, toB64(db.export())); } catch (err) { console.warn('Çevrimdışı veriler kaydedilemedi', err); }
}

// ---------- sample data (dates relative to today, so the demo always looks current) ----------

async function seed(db) {
  const now = new Date().toISOString();
  const today = todayTR();
  const settings = {
    daily_capacity: 160, weekdays: [2], week_interval: 2, start_date: '2026-12-01', confirm_days: 3,
    min_lead_days: 2, max_ahead_days: 120, booking_open: true, season_end: '', notice: '',
  };
  for (const [k, v] of Object.entries(settings)) db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [k, JSON.stringify(v)]);

  const pw = await hashPassword(OFFLINE_DEMO.password);
  db.run('INSERT INTO users (username, display_name, role, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)', [OFFLINE_DEMO.user, 'Gülnihal Hoca', 'staff', pw, now]);
  db.run('INSERT INTO users (username, display_name, role, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)', [OFFLINE_DEMO.admin, 'Yönetici', 'admin', pw, now]);

  // next visit days of the configured rhythm, from the start date (or today if later)
  const visitDays = [];
  for (let d = settings.start_date > today ? settings.start_date : addDays(today, 2); visitDays.length < 4; d = addDays(d, 1)) {
    if (isoWeekday(d) === 2 && Math.round((Date.parse(d) - Date.parse(settings.start_date)) / 86400000 / 7) % 2 === 0) visitDays.push(d);
  }
  const [v1, v2, v3, v4] = visitDays;
  const past1 = addDays(today, -21);
  const past2 = addDays(today, -14);
  const past3 = addDays(today, -7);
  const soon = addDays(today, 2); // inside the confirmation window

  const rows = [
    ['Levent Ortaokulu', 'Beşiktaş', 'Ayşe Yılmaz', 45, 'approved', [past1], past1, '10:00', 'confirmed', 'came'],
    ['Ulus Özel Ortaokulu', 'Beşiktaş', 'Mehmet Kaya', 30, 'approved', [past2], past2, '13:30', 'confirmed', 'came'],
    ['Kağıthane Atatürk Ortaokulu', 'Kağıthane', 'Zeynep Arslan', 60, 'approved', [past3], past3, '10:00', '', ''],
    ['Sarıyer Yahya Kemal Ortaokulu', 'Sarıyer', 'Elif Şahin', 38, 'approved', [soon], soon, '10:30', '', ''],
    ['Beşiktaş Ortaokulu', 'Beşiktaş', 'Can Aydın', 50, 'approved', [v1, v2], v1, '10:00', '', ''],
    ['Üsküdar Bağlarbaşı Ortaokulu', 'Üsküdar', 'Gökhan Çelik', 52, 'approved', [v2], v2, '13:30', '', ''],
    ['Şişli Terakki Ortaokulu', 'Şişli', 'Burak Demir', 25, 'pending', [v1, v2], null, null, '', ''],
    ['Beyoğlu Galatasaray Ortaokulu', 'Beyoğlu', 'Deniz Koç', 40, 'pending', [v2, v3], null, null, '', ''],
    ['Kadıköy Moda Ortaokulu', 'Kadıköy', 'Pelin Erdem', 35, 'pending', [v3, v4], null, null, '', ''],
    ['Esenyurt Cumhuriyet Ortaokulu', 'Esenyurt', 'Onur Polat', 90, 'rejected', [v1], null, null, '', ''],
  ];
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = (n, abc) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => abc[b % abc.length]).join('');
  rows.forEach(([school, district, teacher, n, status, prefs, vd, vt, confirm, att], i) => {
    const created = new Date(Date.now() - (30 - i) * 86400000).toISOString();
    const slug = teacher.split(' ')[0].toLocaleLowerCase('tr').replace(/ş/g, 's').replace(/ı/g, 'i').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/ğ/g, 'g');
    db.run(
      `INSERT INTO applications (code, token, status, school_name, district, teacher_name, teacher_role, phone, email,
        student_count, escort_count, grade, time_pref, preferred_dates, note, visit_date, visit_time, admin_message,
        created_at, updated_at, ip, confirm_status, confirmed_at, confirmed_by, attendance, attendance_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Rehber öğretmen', ?, ?, ?, 2, '8. sınıf', 'Fark etmez', ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?)`,
      [rand(6, alphabet), rand(32, alphabet + 'abcdefghijkmnopqrstuvwxyz'), status, school, district, teacher,
        `0532000${String(100 + i).padStart(4, '0')}`, `${slug}@ornekokul.k12.tr`, n, JSON.stringify(prefs),
        i === 3 ? 'Servisle geleceğiz.' : '', vd, vt,
        status === 'approved' ? 'Ana girişte sizi karşılayacağız.' : status === 'rejected' ? 'Bu tarihte grubunuz için yer kalmadı.' : '',
        created, created, confirm, confirm ? created : null, confirm ? 'öğretmen' : null, att, att ? now : null],
    );
  });
  db.run(`INSERT INTO events (app_id, at, actor, action, detail)
          SELECT id, created_at, 'öğretmen', 'created', replace(replace(replace(preferred_dates, '[', ''), ']', ''), '"', '') FROM applications`);
}

// ---------- boot ----------

let ready;
function open() {
  ready ||= (async () => {
    const SQL = await window.initSqlJs({ wasmBinary: fromB64(window.__SQL_WASM_B64) });
    const saved = load();
    if (saved) {
      try { return new SQL.Database(fromB64(saved)); } catch { /* corrupt: start over */ }
    }
    const db = new SQL.Database();
    db.exec(m1);
    db.exec(m2);
    db.exec(m3);
    await seed(db);
    save(db);
    return db;
  })();
  return ready;
}

// Answer API calls in-page; everything else goes to the network as usual.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith(API_BASE)) return realFetch(input, init);
  const db = await open();
  const request = new Request(url, init);
  const response = await worker.fetch(request, { DB: d1(db), ALLOWED_ORIGINS: '' }, {});
  if (request.method !== 'GET') save(db);
  return response;
};

// file:// shows a folder listing for links that end in "/": send them to index.html instead.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || location.protocol !== 'file:' || a.target === '_blank') return;
  const u = new URL(a.href);
  if (u.protocol === 'file:' && u.pathname.endsWith('/')) {
    e.preventDefault();
    u.pathname += 'index.html';
    location.href = u.href;
  }
}, true);

// A thin bar that says what this is, with a way back to the sample data.
function banner() {
  if (document.querySelector('.offline-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'offline-bar';
  bar.innerHTML = '<span><b>Çevrimdışı tanıtım sürümü</b> · İnternet gerekmez; yapılan başvurular yalnızca bu bilgisayarda saklanır.</span><button type="button">Örnek verilere dön</button>';
  bar.querySelector('button').addEventListener('click', () => {
    if (!window.confirm('Bu bilgisayardaki tüm deneme verileri silinip örnek veriler geri yüklensin mi?')) return;
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('itumtal.')) localStorage.removeItem(k);
    } catch { /* ignore */ }
    location.reload();
  });
  document.body.prepend(bar);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', banner);
else banner();
