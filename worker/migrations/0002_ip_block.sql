-- Kötüye kullanım koruması: başvuranın IP'si ve engellenen IP'ler.

ALTER TABLE applications ADD COLUMN ip TEXT;
CREATE INDEX idx_app_ip ON applications(ip, created_at);
CREATE INDEX idx_app_created ON applications(created_at);

CREATE TABLE blocked_ips (
  ip         TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
