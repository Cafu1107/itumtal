-- Ziyaret başvuruları, panel hesapları ve ayarlar.

CREATE TABLE applications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,          -- short reference, read out on the phone (e.g. K7M2QX)
  token         TEXT NOT NULL UNIQUE,          -- teacher's tracking-link secret (the panel can re-share it)
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  school_name   TEXT NOT NULL,
  district      TEXT NOT NULL,
  teacher_name  TEXT NOT NULL,
  teacher_role  TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL,
  email         TEXT NOT NULL,
  student_count INTEGER NOT NULL,
  escort_count  INTEGER NOT NULL DEFAULT 0,
  grade         TEXT NOT NULL,
  time_pref     TEXT NOT NULL DEFAULT 'Fark etmez',
  preferred_dates TEXT NOT NULL,               -- JSON array of YYYY-MM-DD, in order of preference
  note          TEXT NOT NULL DEFAULT '',
  visit_date    TEXT,                          -- set on approval
  visit_time    TEXT,                          -- HH:MM, set on approval
  admin_message TEXT NOT NULL DEFAULT '',      -- shown to the teacher on the tracking page
  internal_note TEXT NOT NULL DEFAULT '',      -- panel only
  cancelled_by  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_app_status ON applications(status);
CREATE INDEX idx_app_visit ON applications(visit_date, status);
CREATE INDEX idx_app_phone ON applications(phone, status);

CREATE TABLE events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id  INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,                       -- username, or 'öğretmen'
  action  TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_events_app ON events(app_id);

CREATE TABLE users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin','staff')),
  pass_hash    TEXT NOT NULL,
  failed       INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                          -- JSON
);

CREATE TABLE closed_days (
  date   TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT ''
);
