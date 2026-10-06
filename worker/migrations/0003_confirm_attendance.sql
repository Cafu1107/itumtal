-- Katılım teyidi (ziyaretten birkaç gün önce) ve ziyaret sonrası geldi/gelmedi bilgisi.

ALTER TABLE applications ADD COLUMN confirm_status TEXT NOT NULL DEFAULT '';  -- '' | 'confirmed'
ALTER TABLE applications ADD COLUMN confirmed_at TEXT;
ALTER TABLE applications ADD COLUMN confirmed_by TEXT;                        -- 'öğretmen' or a panel username
ALTER TABLE applications ADD COLUMN attendance TEXT NOT NULL DEFAULT '';      -- '' | 'came' | 'no_show'
ALTER TABLE applications ADD COLUMN attendance_at TEXT;
