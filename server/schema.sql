-- TerminPilot — Mehrmandanten-Terminbuchung (Cloudflare D1 / SQLite)
-- Jeder Betrieb ist ein "tenant". Alle Daten sind per tenant_id getrennt.
-- Kundendaten (Name/Telefon/E-Mail/Notiz) liegen nur AES-GCM-verschlüsselt in cdata,
-- mit einem pro Tenant aus MASTER_KEY abgeleiteten Schlüssel.

-- ── Betriebe ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,        -- Subdomain / Pfad: salon-mueller
  name          TEXT NOT NULL,               -- Anzeigename des Betriebs
  branche       TEXT NOT NULL DEFAULT 'allgemein',
  email         TEXT NOT NULL DEFAULT '',    -- Kontakt des Betriebs
  phone         TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  plan          TEXT NOT NULL DEFAULT 'basis',   -- basis | plus | pro
  status        TEXT NOT NULL DEFAULT 'trial',   -- trial | active | past_due | canceled
  trial_ends    INTEGER NOT NULL DEFAULT 0,      -- ms; 0 = kein Trial
  stripe_customer TEXT NOT NULL DEFAULT '',
  stripe_sub      TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ── Einstellungen pro Betrieb (JSON unter key='main', Branding unter key='brand') ──
CREATE TABLE IF NOT EXISTS settings (
  tenant_id TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

-- ── Zugänge der Verwaltung ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  username   TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'team',  -- admin | team
  pw         TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  last_login INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_username ON users (tenant_id, username);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  tenant_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  device     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- Betreiber-Zugang (du): eigene Tabelle, tenant-übergreifend
CREATE TABLE IF NOT EXISTS operators (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  pw         TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS operator_sessions (
  token_hash TEXT PRIMARY KEY,
  op_id      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- ── Dienstleistungen (universal: Haarschnitt, Inspektion, Beratung …) ─────────
CREATE TABLE IF NOT EXISTS services (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  dur          INTEGER NOT NULL DEFAULT 30,   -- Minuten
  buffer_min   INTEGER NOT NULL DEFAULT 0,    -- Puffer danach (Aufräumen/Fahrt)
  price_cents  INTEGER NOT NULL DEFAULT 0,    -- 0 = kein Preis anzeigen
  deposit_cents INTEGER NOT NULL DEFAULT 0,   -- No-Show-Anzahlung (0 = keine)
  active       INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0,
  hint         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_services_tenant ON services (tenant_id, active);

-- ── Mitarbeiter / Ressourcen (Friseur A, Bühne 1, Stuhl 2 …) ──────────────────
CREATE TABLE IF NOT EXISTS staff (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#2563eb',
  active     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staff_tenant ON staff (tenant_id, active);

-- Welche Mitarbeiter bieten welche Leistung an. Keine Zeile für eine Leistung = alle aktiven Mitarbeiter.
CREATE TABLE IF NOT EXISTS service_staff (
  tenant_id  TEXT NOT NULL,
  service_id TEXT NOT NULL,
  staff_id   TEXT NOT NULL,
  PRIMARY KEY (service_id, staff_id)
);

-- ── Termine ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  code          TEXT NOT NULL,              -- Buchungscode für Kunden-Lookup
  date          TEXT NOT NULL,              -- YYYY-MM-DD
  start         INTEGER NOT NULL,           -- Minuten ab Mitternacht (Ortszeit)
  dur           INTEGER NOT NULL,           -- Minuten (inkl. Puffer für Belegung)
  service_id    TEXT NOT NULL DEFAULT '',
  service_name  TEXT NOT NULL DEFAULT '',   -- denormalisiert, damit alte Termine Namen behalten
  staff_id      TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'bestaetigt', -- angefragt|bestaetigt|abgesagt|erledigt|nicht_erschienen
  source        TEXT NOT NULL DEFAULT 'online',     -- online | admin
  cdata         TEXT NOT NULL DEFAULT '',   -- verschlüsselt: {name,phone,email,note,internal}
  has_email     INTEGER NOT NULL DEFAULT 0,
  deposit_cents INTEGER NOT NULL DEFAULT 0,
  deposit_status TEXT NOT NULL DEFAULT 'none', -- none|pending|paid
  reminded      INTEGER NOT NULL DEFAULT 0,  -- Bitmaske: 1=Mail/Push 2=WhatsApp/SMS
  consent       TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_code ON appointments (tenant_id, code);
CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments (tenant_id, date, status);
CREATE INDEX IF NOT EXISTS idx_appt_reminder ON appointments (date, status, reminded);

-- ── Sperrzeiten / Urlaub / Pausen ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blocks (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  staff_id   TEXT NOT NULL DEFAULT '',   -- '' = ganzer Betrieb
  date_from  TEXT NOT NULL,
  date_to    TEXT NOT NULL,
  start      INTEGER,                    -- NULL = ganzer Tag
  stop       INTEGER,
  reason     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_tenant ON blocks (tenant_id, date_to);

-- ── Technik ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ratelimit (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT '',
  user_id   TEXT NOT NULL DEFAULT '',
  user_name TEXT NOT NULL DEFAULT '',
  action    TEXT NOT NULL,
  target    TEXT NOT NULL DEFAULT '',
  note      TEXT NOT NULL DEFAULT '',
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit (tenant_id, at);

CREATE TABLE IF NOT EXISTS push_subs (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  sub       TEXT NOT NULL,
  prefs     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_tenant ON push_subs (tenant_id);

-- VAPID-Schlüssel (Web-Push) global, einmal erzeugt
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
