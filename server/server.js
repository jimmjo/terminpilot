// TerminPilot — Mehrmandanten-Terminbuchung als SaaS (Cloudflare Worker + D1)
// Ein Deployment bedient beliebig viele Betriebe ("tenants"). Trennung strikt per tenant_id.
// Kundendaten liegen nur AES-GCM-verschlüsselt (Schlüssel pro Tenant aus MASTER_KEY abgeleitet).
//
// Secrets (Cloudflare → Worker → Settings → Variables and Secrets):
//   MASTER_KEY            32 Byte Base64  (Pflicht, NIE ändern/verlieren)
//   SIGNUP_ENABLED        "1" erlaubt Selbst-Registrierung (Default: an)
//   OPERATOR_SETUP_CODE   einmaliger Code zum Anlegen des Betreiber-Zugangs
//   APP_ORIGINS           Komma-Liste der eigenen Domains (Verwaltung/Landing)
//   BREVO_API_KEY         optional: E-Mail-Versand
//   WA_API_URL/WA_API_KEY optional: WhatsApp/SMS-Provider (EU)
//   STRIPE_SECRET / STRIPE_WEBHOOK_SECRET / STRIPE_PRICE_BASIS|PLUS|PRO  optional: Abrechnung

const VERSION = '1.0.0';
const PLANS = ['basis', 'plus', 'pro'];
const TENANT_STATES = ['trial', 'active', 'past_due', 'canceled'];
const BRANCHEN = ['allgemein', 'friseur', 'kosmetik', 'werkstatt', 'beratung', 'handwerk', 'praxis'];
const ACTIVE = ['angefragt', 'bestaetigt'];
const STATUSES = ['angefragt', 'bestaetigt', 'abgesagt', 'erledigt', 'nicht_erschienen'];
const SESSION_DAYS = 30;
const TRIAL_DAYS = 14;
const DAY_MS = 86400000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const DEFAULT_SETTINGS = {
  settings_v: 1,
  booking_enabled: true,
  days_ahead: 30,          // so weit im Voraus buchbar
  min_notice_hours: 2,     // frühestens so viele Stunden vorher
  step: 15,                // Raster der Startzeiten (Min)
  retention_days: 180,     // Termine so viele Tage nach dem Termin löschen
  cancel_hours: 24,        // bis wann der Kunde online absagen darf
  reminder: true,          // Erinnerung am Vortag (Mail/Push)
  reminder_wa: false,      // Erinnerung zusätzlich per WhatsApp/SMS (Plan plus/pro)
  require_email: false,    // E-Mail beim Buchen Pflicht
  skip_holidays: true,     // an gesetzlichen Feiertagen (NRW) geschlossen
  notice: '',              // Hinweis oben auf der Buchungsseite
  welcome: '',             // Begrüßungstext
  color: '#2563eb',        // Akzentfarbe der Buchungsseite
  // Öffnungszeiten je Wochentag (0=So … 6=Sa)
  hours: {
    1: [['09:00', '18:00']],
    2: [['09:00', '18:00']],
    3: [['09:00', '18:00']],
    4: [['09:00', '20:00']],
    5: [['09:00', '18:00']],
    6: [['09:00', '14:00']],
  },
};

// ─── Einstieg ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env, ctx);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status, cors);
      console.error(e && e.stack || e);
      return json({ error: 'server', message: 'Interner Fehler. Bitte später erneut versuchen.' }, 500, cors);
    }
  },
  // Cron-Trigger (z. B. "*/5 * * * *"): jede Runde Erinnerungen prüfen, einmal täglich (~03:00) aufräumen.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await dueReminders(env).catch(logErr);
      const now = berlinNow();
      if (now.min >= 180 && now.min < 185) await daily(env).catch(logErr);
    })());
  },
};

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new HttpError(status, code, message); };

// Kein Cookie-Auth (Bearer-Token) → Origin spiegeln ist unkritisch und lässt das Embed-Widget überall laufen.
function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}
async function body(request) {
  try { return await request.json(); } catch { fail(400, 'bad_json', 'Ungültige Anfrage.'); }
}

// ─── Routing ─────────────────────────────────────────────────────────────────
async function route(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;
  if (!env.DB) fail(500, 'no_db', 'Datenbank-Binding DB fehlt.');

  // ── System / öffentlich ──
  if (p === '/api/health') return json({ ok: true, version: VERSION, mail: !!env.BREVO_API_KEY, stripe: !!env.STRIPE_SECRET, wa: !!env.WA_API_URL });
  if (p === '/api/signup' && m === 'POST') return signup(request, env, ctx);
  if (p === '/api/slug-free' && m === 'GET') return slugFree(env, url);
  if (p === '/api/stripe/webhook' && m === 'POST') return stripeWebhook(request, env, ctx);

  // ── Öffentliche Buchung (Tenant per ?b=slug oder Header X-Tenant) ──
  if (p === '/api/public/config' && m === 'GET') return publicConfig(env, await tenantPublic(request, env, url));
  if (p === '/api/public/slots' && m === 'GET') return publicSlots(env, await tenantPublic(request, env, url), url);
  if (p === '/api/public/book' && m === 'POST') return book(request, env, ctx, await tenantPublic(request, env, url));
  if (p === '/api/public/lookup' && m === 'POST') return lookupBooking(request, env, await tenantPublic(request, env, url));
  if (p === '/api/public/cancel' && m === 'POST') return cancelBooking(request, env, ctx, await tenantPublic(request, env, url));

  // ── Verwaltung des Betriebs ──
  if (p === '/api/admin/login' && m === 'POST') return adminLogin(request, env, ctx, url);
  if (p.startsWith('/api/admin/')) {
    const { user, tenant } = await requireUser(request, env);
    const sub = p.slice('/api/admin/'.length);
    const idm = sub.match(/^(appointments|blocks|users|services|staff)\/([A-Za-z0-9-]+)$/);

    if (sub === 'me' && m === 'GET') return json({ user: publicUser(user), tenant: publicTenant(tenant) });
    if (sub === 'logout' && m === 'POST') { await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.token_hash).run(); return json({ ok: true }); }
    if (sub === 'password' && m === 'POST') return changePassword(request, env, user);
    if (sub === 'summary' && m === 'GET') return summary(env, tenant);
    if (sub === 'calendar' && m === 'GET') return calendar(env, tenant, url);
    if (sub === 'appointments' && m === 'GET') return listAppointments(env, tenant, url);
    if (sub === 'appointments' && m === 'POST') return createAppointment(request, env, ctx, user, tenant);
    if (sub === 'search' && m === 'GET') return searchAppointments(env, tenant, url);
    if (sub === 'free' && m === 'GET') return freeForAdmin(env, tenant, url);
    if (sub === 'services' && m === 'GET') return listServices(env, tenant);
    if (sub === 'services' && m === 'POST') return createService(request, env, user, tenant);
    if (sub === 'staff' && m === 'GET') return listStaff(env, tenant);
    if (sub === 'staff' && m === 'POST') return createStaff(request, env, user, tenant);
    if (sub === 'blocks' && m === 'GET') return listBlocks(env, tenant);
    if (sub === 'blocks' && m === 'POST') return createBlock(request, env, user, tenant);
    if (sub === 'settings' && m === 'GET') return json({ settings: await getSettings(env, tenant.id), tenant: publicTenant(tenant), mail: !!env.BREVO_API_KEY });
    if (sub === 'settings' && m === 'PUT') return saveSettings(request, env, user, tenant);
    if (sub === 'profile' && m === 'PUT') return saveProfile(request, env, user, tenant);
    if (sub === 'users' && m === 'GET') return listUsers(env, user, tenant);
    if (sub === 'users' && m === 'POST') return createUser(request, env, user, tenant);
    if (sub === 'billing' && m === 'GET') return billingStatus(env, tenant);
    if (sub === 'billing/checkout' && m === 'POST') return billingCheckout(request, env, user, tenant);
    if (idm) {
      const [, kind, id] = idm;
      if (kind === 'appointments' && m === 'PATCH') return updateAppointment(request, env, ctx, user, tenant, id);
      if (kind === 'appointments' && m === 'DELETE') return deleteAppointment(env, user, tenant, id);
      if (kind === 'services' && m === 'PATCH') return updateService(request, env, user, tenant, id);
      if (kind === 'services' && m === 'DELETE') return deleteService(env, user, tenant, id);
      if (kind === 'staff' && m === 'PATCH') return updateStaff(request, env, user, tenant, id);
      if (kind === 'staff' && m === 'DELETE') return deleteStaff(env, user, tenant, id);
      if (kind === 'blocks' && m === 'DELETE') return deleteBlock(env, user, tenant, id);
      if (kind === 'users' && m === 'PATCH') return updateUser(request, env, user, tenant, id);
      if (kind === 'users' && m === 'DELETE') return deleteUser(env, user, tenant, id);
    }
  }

  // ── Betreiber (du) ──
  if (p === '/api/operator/setup' && m === 'GET') return json({ needed: (await one(env, 'SELECT COUNT(*) n FROM operators')).n === 0 });
  if (p === '/api/operator/setup' && m === 'POST') return operatorSetup(request, env);
  if (p === '/api/operator/login' && m === 'POST') return operatorLogin(request, env);
  if (p.startsWith('/api/operator/')) {
    const op = await requireOperator(request, env);
    const sub = p.slice('/api/operator/'.length);
    if (sub === 'tenants' && m === 'GET') return operatorTenants(env, url);
    if (sub === 'stats' && m === 'GET') return operatorStats(env);
    const tm = sub.match(/^tenants\/([A-Za-z0-9-]+)$/);
    if (tm && m === 'PATCH') return operatorUpdateTenant(request, env, op, tm[1]);
  }

  fail(404, 'not_found', 'Nicht gefunden.');
}

const one = (env, sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const all = async (env, sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results;

// ─── Zeit (deutsche Ortszeit) ─────────────────────────────────────────────────
function berlinNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const o = {};
  for (const x of parts) o[x.type] = x.value;
  return { date: `${o.year}-${o.month}-${o.day}`, min: (parseInt(o.hour, 10) % 24) * 60 + parseInt(o.minute, 10) };
}
const dayNum = d => Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY_MS);
const fromDayNum = n => new Date(n * DAY_MS).toISOString().slice(0, 10);
const addDays = (d, n) => fromDayNum(dayNum(d) + n);
const weekday = d => new Date(dayNum(d) * DAY_MS).getUTCDay();
const toMin = s => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromDayNum(dayNum(s)) === s;
const TAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const deDate = d => `${TAGE[weekday(d)]}, ${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

const holidayCache = {};
function holidays(year) {
  if (holidayCache[year]) return holidayCache[year];
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mm + 114) / 31), day = ((h + l - 7 * mm + 114) % 31) + 1;
  const easter = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const map = {
    [`${year}-01-01`]: 'Neujahr', [addDays(easter, -2)]: 'Karfreitag', [addDays(easter, 1)]: 'Ostermontag',
    [`${year}-05-01`]: 'Tag der Arbeit', [addDays(easter, 39)]: 'Christi Himmelfahrt', [addDays(easter, 50)]: 'Pfingstmontag',
    [addDays(easter, 60)]: 'Fronleichnam', [`${year}-10-03`]: 'Tag der Deutschen Einheit', [`${year}-11-01`]: 'Allerheiligen',
    [`${year}-12-25`]: '1. Weihnachtstag', [`${year}-12-26`]: '2. Weihnachtstag',
  };
  return (holidayCache[year] = map);
}
const holidayName = d => holidays(+d.slice(0, 4))[d] || null;

// ─── Krypto ────────────────────────────────────────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sha256(s) { return b64url(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
function randomToken(bytes = 32) { return b64url(crypto.getRandomValues(new Uint8Array(bytes))); }
function randomCode() {
  const r = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (const x of r) s += CODE_ALPHABET[x % CODE_ALPHABET.length];
  return s;
}
const normCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fmtCode = c => c.slice(0, 4) + '-' + c.slice(4);
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Pro Tenant eigener AES-Schlüssel, aus MASTER_KEY per HKDF abgeleitet (salt = tenant_id).
const keyCache = new Map();
async function tenantKey(env, tid) {
  if (!env.MASTER_KEY) fail(500, 'no_key', 'Secret MASTER_KEY fehlt.');
  const ck = tid + '|' + env.MASTER_KEY;
  if (keyCache.has(ck)) return keyCache.get(ck);
  const raw = unb64(env.MASTER_KEY.trim());
  if (raw.length !== 32) fail(500, 'bad_key', 'MASTER_KEY muss 32 Byte (Base64) sein.');
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('tp:' + tid), info: enc.encode('terminpilot-tenant') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  keyCache.set(ck, key);
  return key;
}
async function seal(env, tid, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await tenantKey(env, tid), enc.encode(JSON.stringify(obj)));
  return 'v1:' + b64(iv) + ':' + b64(ct);
}
async function unseal(env, tid, s) {
  const [v, iv, ct] = String(s).split(':');
  if (v !== 'v1') return {};
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await tenantKey(env, tid), unb64(ct));
    return JSON.parse(dec.decode(pt));
  } catch { return {}; }
}
async function hashPassword(pw, saltB64) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, base, 256);
  return `pbkdf2$100000$${b64(salt)}$${b64(bits)}`;
}
async function checkPassword(pw, stored) {
  const [, , salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  return safeEqual((await hashPassword(pw, salt)).split('$')[3], hash);
}

// ─── Rate-Limit (IP nur als Hash) ─────────────────────────────────────────────
async function hit(env, key, limit, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO ratelimit (key, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN ratelimit.reset_at < ?3 THEN 1 ELSE ratelimit.count + 1 END,
       reset_at = CASE WHEN ratelimit.reset_at < ?3 THEN ?2 ELSE ratelimit.reset_at END
     RETURNING count`
  ).bind(key, now + windowMs, now).first();
  return row.count <= limit;
}
async function ipKey(request, prefix, env) {
  return prefix + ':' + (await sha256('ip:' + (env.MASTER_KEY || '') + (request.headers.get('CF-Connecting-IP') || 'local'))).slice(0, 22);
}
async function limitOrFail(env, key, limit, windowMs) {
  if (!(await hit(env, key, limit, windowMs))) fail(429, 'rate_limited', 'Zu viele Versuche. Bitte einige Minuten warten.');
}
const logErr = e => console.error(e && e.stack || e);
async function audit(env, tid, user, action, target, note) {
  try {
    await env.DB.prepare('INSERT INTO audit (id, tenant_id, user_id, user_name, action, target, note, at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), tid || '', user ? user.id : '', user ? user.name : '', action, target || '', note || '', Date.now()).run();
  } catch (e) { logErr(e); }
}

// ─── Tenant-Auflösung ─────────────────────────────────────────────────────────
async function getTenant(env, slug) {
  const t = await one(env, 'SELECT * FROM tenants WHERE slug = ?', String(slug || '').toLowerCase());
  if (!t) fail(404, 'no_tenant', 'Dieser Betrieb wurde nicht gefunden.');
  return t;
}
// slug aus ?b=, Header X-Tenant oder Subdomain (salon.app.de)
function slugFromRequest(request, url) {
  let slug = url.searchParams.get('b') || request.headers.get('X-Tenant') || '';
  if (!slug) {
    const host = (request.headers.get('Host') || url.hostname || '').split(':')[0];
    const parts = host.split('.');
    if (parts.length >= 3 && !['www', 'app', 'api'].includes(parts[0])) slug = parts[0];
  }
  return String(slug || '').toLowerCase().trim();
}
async function tenantPublic(request, env, url) {
  const slug = slugFromRequest(request, url);
  if (!slug) fail(400, 'no_tenant', 'Kein Betrieb angegeben.');
  const t = await getTenant(env, slug);
  if (!tenantUsable(t)) fail(403, 'tenant_inactive', 'Die Online-Buchung dieses Betriebs ist zurzeit nicht verfügbar.');
  return t;
}
// Buchung möglich, solange Trial läuft oder Abo aktiv (oder Zahlung in Verzug: Kulanz-Fenster aus). canceled = aus.
function tenantUsable(t) {
  if (t.status === 'active') return true;
  if (t.status === 'trial') return t.trial_ends === 0 || t.trial_ends > Date.now();
  return false; // past_due, canceled, abgelaufener Trial
}

// ─── Registrierung (Self-Service) ─────────────────────────────────────────────
const slugOk = s => /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(s);
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'verwaltung', 'betreiber', 'support', 'hilfe', 'blog', 'mail', 'static', 'assets', 'cdn', 'status']);
const makeSlug = s => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

async function slugFree(env, url) {
  const slug = makeSlug(url.searchParams.get('slug') || '');
  const free = slugOk(slug) && !RESERVED.has(slug) && !(await one(env, 'SELECT 1 FROM tenants WHERE slug = ?', slug));
  return json({ slug, free: !!free, valid: slugOk(slug) && !RESERVED.has(slug) });
}

const cleanUsername = u => String(u || '').trim().toLowerCase();
function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) fail(400, 'weak_password', 'Das Passwort muss mindestens 10 Zeichen lang sein.');
  if (pw.length > 200) fail(400, 'weak_password', 'Das Passwort ist zu lang.');
}
const isEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);

async function signup(request, env, ctx) {
  if (env.SIGNUP_ENABLED === '0') fail(403, 'signup_off', 'Registrierung ist zurzeit deaktiviert.');
  await limitOrFail(env, await ipKey(request, 'signup', env), 8, 60 * 60 * 1000);
  const input = await body(request);
  if (input.website) return json({ ok: true, slug: 'demo' }); // Honeypot

  const name = String(input.name || '').trim().slice(0, 80);
  if (name.length < 2) fail(400, 'bad_name', 'Bitte Name des Betriebs angeben.');
  const branche = BRANCHEN.includes(input.branche) ? input.branche : 'allgemein';
  const email = String(input.email || '').trim().toLowerCase();
  if (!isEmail(email)) fail(400, 'bad_email', 'Bitte eine gültige E-Mail angeben.');
  let slug = makeSlug(input.slug || name);
  if (!slugOk(slug) || RESERVED.has(slug)) fail(400, 'bad_slug', 'Die Wunsch-Adresse ist ungültig (nur Buchstaben, Zahlen, Bindestrich).');
  if (await one(env, 'SELECT 1 FROM tenants WHERE slug = ?', slug)) fail(409, 'slug_taken', 'Diese Adresse ist schon vergeben. Bitte eine andere wählen.');
  const username = cleanUsername(input.username) || 'admin';
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) fail(400, 'bad_username', 'Benutzername: 3–40 Zeichen (Buchstaben, Zahlen, Punkt, Strich).');
  checkNewPassword(input.password);

  const now = Date.now();
  const tid = crypto.randomUUID();
  const uid = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO tenants (id, slug, name, branche, email, plan, status, trial_ends, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(tid, slug, name, branche, email, 'basis', 'trial', now + TRIAL_DAYS * DAY_MS, now, now),
    env.DB.prepare('INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?)')
      .bind(tid, 'main', JSON.stringify({ ...DEFAULT_SETTINGS, welcome: `Willkommen bei ${name}` })),
    env.DB.prepare('INSERT INTO users (id, tenant_id, username, name, role, pw, active, created_at) VALUES (?,?,?,?,?,?,1,?)')
      .bind(uid, tid, username, name, 'admin', await hashPassword(input.password), now),
  ]);
  // Branchen-Starterpaket (ein paar Beispiel-Leistungen) anlegen
  await seedTenant(env, tid, branche, now);
  await audit(env, tid, { id: uid, name }, 'registriert', slug, branche);
  ctx.waitUntil(mailSignup(env, email, name, slug).catch(logErr));

  // direkt einloggen
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, tenant_id, created_at, expires_at, device) VALUES (?,?,?,?,?,?)')
    .bind(await sha256(token), uid, tid, now, now + SESSION_DAYS * DAY_MS, 'signup').run();
  const tenant = await one(env, 'SELECT * FROM tenants WHERE id = ?', tid);
  const user = await one(env, 'SELECT * FROM users WHERE id = ?', uid);
  return json({ ok: true, slug, token, user: publicUser(user), tenant: publicTenant(tenant) });
}

const SEEDS = {
  friseur: [['Waschen, Schneiden, Föhnen', 45, 3900], ['Herrenhaarschnitt', 30, 2500], ['Färben', 90, 7500], ['Ponyschnitt', 15, 1000]],
  kosmetik: [['Gesichtsbehandlung', 60, 5900], ['Maniküre', 45, 3500], ['Wimpern', 75, 8900]],
  werkstatt: [['Inspektion', 60, 0], ['Reifenwechsel', 30, 4900], ['Ölwechsel', 45, 0], ['HU/AU-Termin', 30, 0]],
  beratung: [['Erstgespräch', 30, 0], ['Beratung', 60, 0]],
  handwerk: [['Aufmaß / Besichtigung', 45, 0], ['Beratungstermin', 30, 0]],
  praxis: [['Sprechstunde', 15, 0], ['Vorsorge', 30, 0], ['Beratung', 20, 0]],
  allgemein: [['Termin', 30, 0], ['Beratung', 60, 0]],
};
async function seedTenant(env, tid, branche, now) {
  const sid = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO staff (id, tenant_id, name, color, active, sort, created_at) VALUES (?,?,?,?,1,0,?)')
    .bind(sid, tid, 'Team', '#2563eb', now).run();
  const list = SEEDS[branche] || SEEDS.allgemein;
  const stmts = list.map(([n, dur, price], i) =>
    env.DB.prepare('INSERT INTO services (id, tenant_id, name, dur, price_cents, active, sort, created_at) VALUES (?,?,?,?,?,1,?,?)')
      .bind(crypto.randomUUID(), tid, n, dur, price, i, now));
  if (stmts.length) await env.DB.batch(stmts);
}

// ─── Einstellungen pro Tenant ─────────────────────────────────────────────────
async function getSettings(env, tid) {
  const row = await one(env, "SELECT value FROM settings WHERE tenant_id = ? AND key = 'main'", tid);
  let s = {};
  try { s = row ? JSON.parse(row.value) : {}; } catch { s = {}; }
  return { ...DEFAULT_SETTINGS, ...s };
}
function cleanSettings(input, old) {
  const s = { ...old };
  const int = (v, min, max, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
  const bool = (k) => { if (k in input) s[k] = !!input[k]; };
  ['booking_enabled', 'reminder', 'reminder_wa', 'require_email', 'skip_holidays'].forEach(bool);
  if ('days_ahead' in input) s.days_ahead = int(input.days_ahead, 1, 180, old.days_ahead);
  if ('min_notice_hours' in input) s.min_notice_hours = int(input.min_notice_hours, 0, 336, old.min_notice_hours);
  if ('cancel_hours' in input) s.cancel_hours = int(input.cancel_hours, 0, 336, old.cancel_hours);
  if ('step' in input) s.step = [5, 10, 15, 20, 30, 60].includes(+input.step) ? +input.step : old.step;
  if ('retention_days' in input) s.retention_days = int(input.retention_days, 7, 3650, old.retention_days);
  if ('notice' in input) s.notice = String(input.notice || '').trim().slice(0, 400);
  if ('welcome' in input) s.welcome = String(input.welcome || '').trim().slice(0, 400);
  if ('color' in input) { const c = String(input.color || '').trim(); s.color = /^#[0-9a-fA-F]{6}$/.test(c) ? c : old.color; }
  if ('hours' in input) {
    const h = {};
    for (let d = 0; d <= 6; d++) {
      const list = Array.isArray(input.hours[d]) ? input.hours[d] : [];
      const ok = [];
      for (const r of list) {
        if (!Array.isArray(r) || !/^\d{2}:\d{2}$/.test(r[0]) || !/^\d{2}:\d{2}$/.test(r[1])) continue;
        if (toMin(r[1]) <= toMin(r[0]) || toMin(r[1]) > 24 * 60) fail(400, 'bad_hours', `Zeitraum ${r[0]}–${r[1]} am ${TAGE[d]} ist ungültig.`);
        ok.push([r[0], r[1]]);
      }
      ok.sort((a, b) => toMin(a[0]) - toMin(b[0]));
      if (ok.length) h[d] = ok;
    }
    s.hours = h;
  }
  return s;
}
async function saveSettings(request, env, user, tenant) {
  requireAdmin(user);
  const s = cleanSettings(await body(request) || {}, await getSettings(env, tenant.id));
  await env.DB.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'main', ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value")
    .bind(tenant.id, JSON.stringify(s)).run();
  await audit(env, tenant.id, user, 'einstellungen', '', '');
  return json({ settings: s });
}
async function saveProfile(request, env, user, tenant) {
  requireAdmin(user);
  const input = await body(request);
  const name = String(input.name || tenant.name).trim().slice(0, 80) || tenant.name;
  const email = String(input.email ?? tenant.email).trim().toLowerCase();
  if (email && !isEmail(email)) fail(400, 'bad_email', 'E-Mail ist ungültig.');
  const phone = String(input.phone ?? tenant.phone).trim().slice(0, 40);
  const address = String(input.address ?? tenant.address).trim().slice(0, 200);
  await env.DB.prepare('UPDATE tenants SET name=?, email=?, phone=?, address=?, updated_at=? WHERE id=?')
    .bind(name, email, phone, address, Date.now(), tenant.id).run();
  await audit(env, tenant.id, user, 'profil', '', '');
  return json({ tenant: publicTenant({ ...tenant, name, email, phone, address }) });
}

// ─── Dienstleistungen ─────────────────────────────────────────────────────────
const pubService = s => ({ id: s.id, name: s.name, dur: s.dur, buffer_min: s.buffer_min, price_cents: s.price_cents, deposit_cents: s.deposit_cents, active: !!s.active, sort: s.sort, hint: s.hint });
async function listServices(env, tenant) {
  const rows = await all(env, 'SELECT * FROM services WHERE tenant_id = ? ORDER BY sort, created_at', tenant.id);
  const map = await all(env, 'SELECT service_id, staff_id FROM service_staff WHERE tenant_id = ?', tenant.id);
  const byS = {};
  for (const m of map) (byS[m.service_id] ||= []).push(m.staff_id);
  return json({ services: rows.map(s => ({ ...pubService(s), staff: byS[s.id] || [] })) });
}
function cleanService(input, old = {}) {
  const int = (v, min, max, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
  const name = String(input.name ?? old.name ?? '').trim().slice(0, 80);
  if (!name) fail(400, 'bad_service', 'Jede Leistung braucht einen Namen.');
  return {
    name,
    dur: int(input.dur, 5, 600, old.dur ?? 30),
    buffer_min: int(input.buffer_min, 0, 240, old.buffer_min ?? 0),
    price_cents: int(input.price_cents, 0, 10000000, old.price_cents ?? 0),
    deposit_cents: int(input.deposit_cents, 0, 10000000, old.deposit_cents ?? 0),
    active: 'active' in input ? (input.active ? 1 : 0) : (old.active ?? 1),
    sort: int(input.sort, 0, 9999, old.sort ?? 0),
    hint: String(input.hint ?? old.hint ?? '').trim().slice(0, 160),
  };
}
async function setServiceStaff(env, tenant, serviceId, staffIds) {
  if (!Array.isArray(staffIds)) return;
  await env.DB.prepare('DELETE FROM service_staff WHERE tenant_id = ? AND service_id = ?').bind(tenant.id, serviceId).run();
  const valid = new Set((await all(env, 'SELECT id FROM staff WHERE tenant_id = ?', tenant.id)).map(r => r.id));
  const ins = staffIds.filter(id => valid.has(id)).map(id =>
    env.DB.prepare('INSERT OR IGNORE INTO service_staff (tenant_id, service_id, staff_id) VALUES (?,?,?)').bind(tenant.id, serviceId, id));
  if (ins.length) await env.DB.batch(ins);
}
async function createService(request, env, user, tenant) {
  requireAdmin(user);
  const input = await body(request);
  const c = cleanService(input);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO services (id, tenant_id, name, dur, buffer_min, price_cents, deposit_cents, active, sort, hint, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, tenant.id, c.name, c.dur, c.buffer_min, c.price_cents, c.deposit_cents, c.active, c.sort, c.hint, Date.now()).run();
  await setServiceStaff(env, tenant, id, input.staff);
  await audit(env, tenant.id, user, 'leistung_neu', id, c.name);
  return json({ id });
}
async function updateService(request, env, user, tenant, id) {
  requireAdmin(user);
  const old = await one(env, 'SELECT * FROM services WHERE id = ? AND tenant_id = ?', id, tenant.id);
  if (!old) fail(404, 'not_found', 'Leistung nicht gefunden.');
  const input = await body(request);
  const c = cleanService(input, old);
  await env.DB.prepare('UPDATE services SET name=?, dur=?, buffer_min=?, price_cents=?, deposit_cents=?, active=?, sort=?, hint=? WHERE id=? AND tenant_id=?')
    .bind(c.name, c.dur, c.buffer_min, c.price_cents, c.deposit_cents, c.active, c.sort, c.hint, id, tenant.id).run();
  if ('staff' in input) await setServiceStaff(env, tenant, id, input.staff);
  await audit(env, tenant.id, user, 'leistung_geaendert', id, c.name);
  return json({ ok: true });
}
async function deleteService(env, user, tenant, id) {
  requireAdmin(user);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM services WHERE id = ? AND tenant_id = ?').bind(id, tenant.id),
    env.DB.prepare('DELETE FROM service_staff WHERE service_id = ? AND tenant_id = ?').bind(id, tenant.id),
  ]);
  await audit(env, tenant.id, user, 'leistung_geloescht', id, '');
  return json({ ok: true });
}

// ─── Mitarbeiter / Ressourcen ─────────────────────────────────────────────────
const pubStaff = s => ({ id: s.id, name: s.name, color: s.color, active: !!s.active, sort: s.sort });
async function listStaff(env, tenant) {
  const rows = await all(env, 'SELECT * FROM staff WHERE tenant_id = ? ORDER BY sort, created_at', tenant.id);
  return json({ staff: rows.map(pubStaff) });
}
async function createStaff(request, env, user, tenant) {
  requireAdmin(user);
  const input = await body(request);
  const name = String(input.name || '').trim().slice(0, 60);
  if (!name) fail(400, 'bad_staff', 'Bitte einen Namen angeben.');
  const color = /^#[0-9a-fA-F]{6}$/.test(input.color) ? input.color : '#2563eb';
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO staff (id, tenant_id, name, color, active, sort, created_at) VALUES (?,?,?,?,1,?,?)')
    .bind(id, tenant.id, name, color, parseInt(input.sort, 10) || 0, Date.now()).run();
  await audit(env, tenant.id, user, 'mitarbeiter_neu', id, name);
  return json({ id });
}
async function updateStaff(request, env, user, tenant, id) {
  requireAdmin(user);
  const old = await one(env, 'SELECT * FROM staff WHERE id = ? AND tenant_id = ?', id, tenant.id);
  if (!old) fail(404, 'not_found', 'Mitarbeiter nicht gefunden.');
  const input = await body(request);
  const name = String(input.name ?? old.name).trim().slice(0, 60) || old.name;
  const color = /^#[0-9a-fA-F]{6}$/.test(input.color) ? input.color : old.color;
  const active = 'active' in input ? (input.active ? 1 : 0) : old.active;
  await env.DB.prepare('UPDATE staff SET name=?, color=?, active=?, sort=? WHERE id=? AND tenant_id=?')
    .bind(name, color, active, parseInt(input.sort, 10) || old.sort, id, tenant.id).run();
  await audit(env, tenant.id, user, 'mitarbeiter_geaendert', id, name);
  return json({ ok: true });
}
async function deleteStaff(env, user, tenant, id) {
  requireAdmin(user);
  const cnt = (await one(env, "SELECT COUNT(*) n FROM appointments WHERE tenant_id=? AND staff_id=? AND status IN ('angefragt','bestaetigt') AND date >= ?", tenant.id, id, berlinNow().date)).n;
  if (cnt > 0) fail(409, 'has_appts', `Dieser Mitarbeiter hat noch ${cnt} offene Termine. Bitte zuerst umbuchen oder auf „inaktiv“ setzen.`);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM staff WHERE id = ? AND tenant_id = ?').bind(id, tenant.id),
    env.DB.prepare('DELETE FROM service_staff WHERE staff_id = ? AND tenant_id = ?').bind(id, tenant.id),
  ]);
  await audit(env, tenant.id, user, 'mitarbeiter_geloescht', id, '');
  return json({ ok: true });
}

// ─── Freie Zeiten (mitarbeiter-/ressourcenbewusst) ────────────────────────────
async function eligibleStaff(env, tenant, serviceId) {
  const staff = await all(env, 'SELECT id, name, color FROM staff WHERE tenant_id = ? AND active = 1 ORDER BY sort, created_at', tenant.id);
  const map = await all(env, 'SELECT staff_id FROM service_staff WHERE tenant_id = ? AND service_id = ?', tenant.id, serviceId);
  if (!map.length) return staff; // keine Zuordnung = alle
  const allow = new Set(map.map(r => r.staff_id));
  const filtered = staff.filter(s => allow.has(s.id));
  return filtered.length ? filtered : staff;
}
async function loadBusy(env, tenant, from, to) {
  const appts = await all(env,
    "SELECT id, date, start, dur, staff_id FROM appointments WHERE tenant_id=? AND date>=? AND date<=? AND status IN ('angefragt','bestaetigt')",
    tenant.id, from, to);
  const blocks = await all(env, 'SELECT * FROM blocks WHERE tenant_id=? AND date_to>=? AND date_from<=?', tenant.id, from, to);
  const byDate = {};
  for (const a of appts) (byDate[a.date] ||= []).push(a);
  return { byDate, blocks };
}
const blocksFor = (blocks, date) => blocks.filter(b => b.date_from <= date && b.date_to >= date);
// Ist Mitarbeiter st zur Zeit [s, s+dur) frei? (keine Überschneidung, kein Block)
function staffFree(st, s, dur, appts, blocks) {
  for (const a of appts) if (a.staff_id === st && s < a.start + a.dur && s + dur > a.start) return false;
  for (const b of blocks) {
    if (b.staff_id && b.staff_id !== st) continue;      // Block nur für anderen Mitarbeiter
    if (b.start == null) return false;                  // ganztägig zu
    if (s < b.stop && s + dur > b.start) return false;  // Zeit-Block
  }
  return true;
}
// Liefert für einen Tag die freien Startzeiten + je Startzeit die freien Mitarbeiter
function freeStartsDetailed(settings, staffList, busy, date, dur, opts = {}) {
  if (settings.skip_holidays && holidayName(date)) return [];
  const ranges = (settings.hours[weekday(date)] || []).map(r => [toMin(r[0]), toMin(r[1])]);
  if (!ranges.length) return [];
  const appts = busy.byDate[date] || [];
  const bl = blocksFor(busy.blocks, date);
  if (bl.some(b => !b.staff_id && b.start == null)) return []; // ganzer Betrieb geschlossen
  const out = [];
  for (const [rs, re] of ranges) {
    for (let s = rs; s + dur <= re; s += settings.step) {
      if (opts.minStart != null && s < opts.minStart) continue;
      const freeStaff = staffList.filter(st => staffFree(st.id, s, dur, appts, bl));
      if (freeStaff.length) out.push({ start: s, staff: freeStaff.map(st => st.id) });
    }
  }
  return out;
}
function bookingWindow(settings) {
  const now = berlinNow();
  const earliestAbs = dayNum(now.date) * 1440 + now.min + settings.min_notice_hours * 60;
  return { now, first: now.date, last: addDays(now.date, settings.days_ahead), earliestAbs };
}
const minStartFor = (date, earliestAbs) => { const m = earliestAbs - dayNum(date) * 1440; return m > 0 ? m : null; };

// ─── Öffentlich: Konfiguration + Slots ────────────────────────────────────────
function publicTenant(t) {
  return { id: t.id, slug: t.slug, name: t.name, branche: t.branche, email: t.email, phone: t.phone, address: t.address, plan: t.plan, status: t.status, trial_ends: t.trial_ends };
}
async function publicConfig(env, tenant) {
  const s = await getSettings(env, tenant.id);
  const services = (await all(env, 'SELECT * FROM services WHERE tenant_id=? AND active=1 ORDER BY sort, created_at', tenant.id))
    .map(x => ({ id: x.id, name: x.name, dur: x.dur, price_cents: x.price_cents, hint: x.hint }));
  const staff = (await all(env, 'SELECT id, name FROM staff WHERE tenant_id=? AND active=1 ORDER BY sort, created_at', tenant.id))
    .map(x => ({ id: x.id, name: x.name }));
  return json({
    name: tenant.name, phone: tenant.phone, address: tenant.address, branche: tenant.branche,
    booking_enabled: s.booking_enabled, days_ahead: s.days_ahead, notice: s.notice, welcome: s.welcome, color: s.color,
    require_email: s.require_email, mail: !!env.BREVO_API_KEY, services, staff,
  }, 200, { 'Cache-Control': 'public, max-age=20' });
}
async function publicSlots(env, tenant, url) {
  const s = await getSettings(env, tenant.id);
  if (!s.booking_enabled) return json({ dates: [] });
  const service = await one(env, 'SELECT * FROM services WHERE id=? AND tenant_id=? AND active=1', url.searchParams.get('service'), tenant.id);
  if (!service) fail(400, 'bad_service', 'Unbekannte Leistung.');
  const dur = service.dur + service.buffer_min;
  let staffList = await eligibleStaff(env, tenant, service.id);
  const wantStaff = url.searchParams.get('staff');
  if (wantStaff && wantStaff !== 'any') staffList = staffList.filter(st => st.id === wantStaff);
  if (!staffList.length) return json({ dates: [] });
  const w = bookingWindow(s);
  const busy = await loadBusy(env, tenant, w.first, w.last);
  const dates = [];
  for (let d = w.first; d <= w.last; d = addDays(d, 1)) {
    const wd = weekday(d);
    if (!s.hours[wd] || !s.hours[wd].length) continue;
    const hol = s.skip_holidays && holidayName(d);
    const closed = hol || (blocksFor(busy.blocks, d).some(b => !b.staff_id && b.start == null) ? 'geschlossen' : null);
    const slots = closed ? [] : freeStartsDetailed(s, staffList, busy, d, dur, { minStart: minStartFor(d, w.earliestAbs) });
    if (!closed && !slots.length && (dayNum(d) + 1) * 1440 <= w.earliestAbs) continue;
    dates.push({ date: d, slots: slots.map(x => x.start), closed });
  }
  return json({ dates });
}

// ─── Öffentlich: Buchen ───────────────────────────────────────────────────────
function cleanCustomer(input, requireEmail) {
  const name = String(input.name || '').trim().replace(/\s+/g, ' ');
  const phone = String(input.phone || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const note = String(input.note || '').trim().slice(0, 300);
  if (name.length < 2 || name.length > 100) fail(400, 'bad_name', 'Bitte Namen angeben.');
  if (!/^[+0-9][0-9 ()/\-]{5,24}$/.test(phone)) fail(400, 'bad_phone', 'Bitte eine gültige Telefonnummer angeben.');
  if (email && !isEmail(email)) fail(400, 'bad_email', 'Bitte die E-Mail-Adresse prüfen.');
  if (requireEmail && !email) fail(400, 'need_email', 'Bitte eine E-Mail-Adresse angeben.');
  return { name, phone, email, note };
}
const TAKEN = 'Dieser Termin ist nicht mehr frei. Bitte wählen Sie eine andere Zeit.';

async function book(request, env, ctx, tenant) {
  const input = await body(request);
  if (input.website) return json({ ok: true, code: 'XXXX-XXXX', status: 'bestaetigt' }); // Honeypot
  await limitOrFail(env, await ipKey(request, 'book', env), 30, 60 * 60 * 1000);

  const s = await getSettings(env, tenant.id);
  if (!s.booking_enabled) fail(403, 'closed', 'Die Online-Buchung ist gerade geschlossen.');
  if (input.consent !== true) fail(400, 'no_consent', 'Bitte die Einwilligung bestätigen.');
  const service = await one(env, 'SELECT * FROM services WHERE id=? AND tenant_id=? AND active=1', input.service, tenant.id);
  if (!service) fail(400, 'bad_service', 'Bitte eine Leistung wählen.');
  const c = cleanCustomer(input, s.require_email);
  if (!env.BREVO_API_KEY) c.email = c.email; // E-Mail trotzdem speichern (für WhatsApp/SMS-Erinnerung reicht Telefon)

  const dur = service.dur + service.buffer_min;
  const date = input.date, start = parseInt(input.start, 10);
  if (!isDate(date) || !Number.isFinite(start)) fail(400, 'bad_slot', 'Bitte Tag und Uhrzeit wählen.');
  const w = bookingWindow(s);
  if (date < w.first || date > w.last) fail(409, 'slot_taken', TAKEN);

  // passenden freien Mitarbeiter bestimmen (Wunsch beachten, sonst gleichmäßig verteilen)
  let staffList = await eligibleStaff(env, tenant, service.id);
  const wantStaff = String(input.staff || 'any');
  if (wantStaff !== 'any') { staffList = staffList.filter(st => st.id === wantStaff); if (!staffList.length) fail(400, 'bad_staff', 'Mitarbeiter nicht verfügbar.'); }
  if (!staffList.length) fail(409, 'slot_taken', TAKEN);

  let code, assigned;
  for (let tries = 0; tries < 6; tries++) {
    const busy = await loadBusy(env, tenant, date, date);
    const appts = busy.byDate[date] || [];
    const bl = blocksFor(busy.blocks, date);
    if (s.skip_holidays && holidayName(date)) fail(409, 'slot_taken', TAKEN);
    if (!(s.hours[weekday(date)] || []).some(r => start >= toMin(r[0]) && start + dur <= toMin(r[1]))) fail(409, 'slot_taken', TAKEN);
    if (minStartFor(date, w.earliestAbs) != null && start < minStartFor(date, w.earliestAbs)) fail(409, 'slot_taken', TAKEN);
    // freie Mitarbeiter, am wenigsten ausgelasteten zuerst
    const free = staffList.filter(st => staffFree(st.id, start, dur, appts, bl));
    if (!free.length) fail(409, 'slot_taken', TAKEN);
    const load = {};
    for (const a of appts) load[a.staff_id] = (load[a.staff_id] || 0) + 1;
    free.sort((a, b) => (load[a.id] || 0) - (load[b.id] || 0));
    assigned = free[0].id;

    code = randomCode();
    const id = crypto.randomUUID();
    const cdata = await seal(env, tenant.id, { ...c, internal: '' });
    // atomar: nur einfügen, wenn dieser Mitarbeiter zur Zeit noch frei ist
    const res = await env.DB.prepare(
      `INSERT INTO appointments (id, tenant_id, code, date, start, dur, service_id, service_name, staff_id, status, source, cdata, has_email, deposit_cents, deposit_status, consent, created_at, updated_at, updated_by)
       SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,'bestaetigt','online',?10,?11,?12,?13,?14,?15,?15,'online'
       WHERE (SELECT COUNT(*) FROM appointments WHERE tenant_id=?2 AND staff_id=?9 AND date=?4 AND status IN ('angefragt','bestaetigt') AND start < ?5 + ?6 AND start + dur > ?5) = 0`
    ).bind(id, tenant.id, code, date, start, dur, service.id, service.name, assigned, cdata, c.email ? 1 : 0,
      service.deposit_cents, service.deposit_cents > 0 ? 'pending' : 'none', 'v1', Date.now()).run();
    if (res.meta.changes) {
      await audit(env, tenant.id, null, 'online_gebucht', id, service.name);
      const appt = { id, code, date, start, dur: service.dur, service_name: service.name, staff_id: assigned };
      if (c.email && env.BREVO_API_KEY) ctx.waitUntil(mailCustomer(env, tenant, s, c.email, 'bestaetigt', appt).catch(logErr));
      return json({
        ok: true, code: fmtCode(code), status: 'bestaetigt', date, start, dur: service.dur, service: service.name,
        deposit_cents: service.deposit_cents, mail: !!(c.email && env.BREVO_API_KEY),
      });
    }
    // Rennen verloren → neu berechnen
  }
  fail(409, 'slot_taken', TAKEN);
}

async function findByCode(env, tenant, request, input) {
  await limitOrFail(env, await ipKey(request, 'lookup', env), 15, 15 * 60 * 1000);
  const code = normCode(input.code);
  if (code.length !== 8) fail(400, 'bad_code', 'Bitte den Buchungscode prüfen.');
  const row = await one(env, 'SELECT * FROM appointments WHERE tenant_id=? AND code=?', tenant.id, code);
  if (!row) fail(404, 'not_found', 'Kein Termin zu diesen Angaben gefunden.');
  const p = await unseal(env, tenant.id, row.cdata);
  const phone = String(input.phone || '').replace(/[^0-9+]/g, '');
  if (!phone || (p.phone || '').replace(/[^0-9+]/g, '') !== phone) fail(404, 'not_found', 'Kein Termin zu diesen Angaben gefunden.');
  return { row, p };
}
function canCancel(row, cancelHours) {
  const now = berlinNow();
  const abs = dayNum(row.date) * 1440 + row.start;
  return ACTIVE.includes(row.status) && abs - (dayNum(now.date) * 1440 + now.min) >= cancelHours * 60;
}
async function lookupBooking(request, env, tenant) {
  const { row } = await findByCode(env, tenant, request, await body(request));
  const s = await getSettings(env, tenant.id);
  return json({ code: fmtCode(row.code), date: row.date, start: row.start, dur: row.dur, service: row.service_name, status: row.status, can_cancel: canCancel(row, s.cancel_hours) });
}
async function cancelBooking(request, env, ctx, tenant) {
  const { row, p } = await findByCode(env, tenant, request, await body(request));
  const s = await getSettings(env, tenant.id);
  if (!canCancel(row, s.cancel_hours)) fail(409, 'not_cancelable', `Dieser Termin kann online nicht mehr abgesagt werden. Bitte den Betrieb anrufen${tenant.phone ? ': ' + tenant.phone : ''}.`);
  await env.DB.prepare("UPDATE appointments SET status='abgesagt', updated_at=?, updated_by='kunde' WHERE id=? AND tenant_id=?").bind(Date.now(), row.id, tenant.id).run();
  await audit(env, tenant.id, null, 'kunde_abgesagt', row.id, '');
  if (p.email && env.BREVO_API_KEY) ctx.waitUntil(mailCustomer(env, tenant, s, p.email, 'storniert', row).catch(logErr));
  return json({ ok: true });
}

// ─── Verwaltung: Anmeldung ──────────────────────────────────────────────────
const publicUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active, last_login: u.last_login || null });
function requireAdmin(user) { if (user.role !== 'admin') fail(403, 'forbidden', 'Nur für Inhaber-Zugänge.'); }

async function adminLogin(request, env, ctx, url) {
  const input = await body(request);
  const slug = String(input.slug || slugFromRequest(request, url)).toLowerCase().trim();
  if (!slug) fail(400, 'no_tenant', 'Bitte die Betriebs-Adresse angeben.');
  const tenant = await one(env, 'SELECT * FROM tenants WHERE slug = ?', slug);
  if (!tenant) fail(404, 'no_tenant', 'Betrieb nicht gefunden.');
  const username = cleanUsername(input.username);
  await limitOrFail(env, await ipKey(request, 'login', env), 25, 15 * 60 * 1000);
  const userKey = 'loginuser:' + (await sha256(tenant.id + ':' + username)).slice(0, 22);
  const rl = await one(env, 'SELECT * FROM ratelimit WHERE key = ?', userKey);
  if (rl && rl.count >= 6 && rl.reset_at > Date.now()) fail(429, 'locked', 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.');

  const user = await one(env, 'SELECT * FROM users WHERE tenant_id=? AND username=?', tenant.id, username);
  const ok = user && user.active && await checkPassword(String(input.password || ''), user.pw);
  if (!ok) { await hit(env, userKey, 6, 15 * 60 * 1000); fail(401, 'bad_login', 'Benutzername oder Passwort falsch.'); }
  await env.DB.prepare('DELETE FROM ratelimit WHERE key = ?').bind(userKey).run();
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, tenant_id, created_at, expires_at, device) VALUES (?,?,?,?,?,?)')
    .bind(await sha256(token), user.id, tenant.id, now, now + SESSION_DAYS * DAY_MS, String(input.device || '').slice(0, 80)).run();
  await env.DB.prepare('UPDATE users SET last_login=? WHERE id=?').bind(now, user.id).run();
  ctx.waitUntil(cleanupSessions(env).catch(logErr));
  return json({ token, user: publicUser(user), tenant: publicTenant(tenant) });
}
async function cleanupSessions(env) {
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
  await env.DB.prepare('DELETE FROM operator_sessions WHERE expires_at < ?').bind(Date.now()).run();
  await env.DB.prepare('DELETE FROM ratelimit WHERE reset_at < ?').bind(Date.now()).run();
}
async function requireUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) fail(401, 'no_session', 'Bitte anmelden.');
  const th = await sha256(token);
  const now = Date.now();
  const row = await one(env, 'SELECT s.token_hash, s.expires_at, s.tenant_id, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', th);
  if (!row || row.expires_at < now || !row.active) fail(401, 'no_session', 'Sitzung abgelaufen. Bitte neu anmelden.');
  if (row.expires_at - now < (SESSION_DAYS - 1) * DAY_MS) await env.DB.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').bind(now + SESSION_DAYS * DAY_MS, th).run();
  const tenant = await one(env, 'SELECT * FROM tenants WHERE id = ?', row.tenant_id);
  if (!tenant) fail(401, 'no_tenant', 'Betrieb nicht gefunden.');
  return { user: row, tenant };
}
async function changePassword(request, env, user) {
  const input = await body(request);
  if (!(await checkPassword(String(input.old || ''), user.pw))) fail(400, 'bad_old', 'Das bisherige Passwort stimmt nicht.');
  checkNewPassword(input.new);
  await env.DB.prepare('UPDATE users SET pw=? WHERE id=?').bind(await hashPassword(input.new), user.id).run();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').bind(user.id, user.token_hash).run();
  await audit(env, user.tenant_id, user, 'passwort_geaendert', '', '');
  return json({ ok: true });
}

// ─── Verwaltung: Team ──────────────────────────────────────────────────────
async function listUsers(env, user, tenant) {
  requireAdmin(user);
  const r = await all(env, 'SELECT * FROM users WHERE tenant_id=? ORDER BY created_at', tenant.id);
  return json({ users: r.map(publicUser) });
}
async function createUser(request, env, user, tenant) {
  requireAdmin(user);
  const input = await body(request);
  const username = cleanUsername(input.username);
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) fail(400, 'bad_username', 'Benutzername: 3–40 Zeichen.');
  checkNewPassword(input.password);
  if (await one(env, 'SELECT 1 FROM users WHERE tenant_id=? AND username=?', tenant.id, username)) fail(409, 'exists', 'Benutzername schon vergeben.');
  const role = input.role === 'admin' ? 'admin' : 'team';
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, tenant_id, username, name, role, pw, active, created_at) VALUES (?,?,?,?,?,?,1,?)')
    .bind(id, tenant.id, username, String(input.name || username).slice(0, 60), role, await hashPassword(input.password), Date.now()).run();
  await audit(env, tenant.id, user, 'zugang_neu', id, username);
  return json({ id });
}
async function updateUser(request, env, user, tenant, id) {
  requireAdmin(user);
  const target = await one(env, 'SELECT * FROM users WHERE id=? AND tenant_id=?', id, tenant.id);
  if (!target) fail(404, 'not_found', 'Zugang nicht gefunden.');
  const input = await body(request);
  let role = target.role, active = target.active;
  if ('role' in input) role = input.role === 'admin' ? 'admin' : 'team';
  if ('active' in input) active = input.active ? 1 : 0;
  if (target.id === user.id && (role !== 'admin' || !active)) fail(400, 'self', 'Der eigene Inhaber-Zugang kann nicht herabgestuft werden.');
  if (target.role === 'admin' && role !== 'admin') {
    const admins = (await one(env, "SELECT COUNT(*) n FROM users WHERE tenant_id=? AND role='admin' AND active=1", tenant.id)).n;
    if (admins <= 1) fail(400, 'last_admin', 'Es muss mindestens ein Inhaber-Zugang bleiben.');
  }
  await env.DB.prepare('UPDATE users SET role=?, active=? WHERE id=? AND tenant_id=?').bind(role, active, id, tenant.id).run();
  if (!active) await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
  if ('password' in input) { checkNewPassword(input.password); await env.DB.prepare('UPDATE users SET pw=? WHERE id=?').bind(await hashPassword(input.password), id).run(); }
  await audit(env, tenant.id, user, 'zugang_geaendert', id, '');
  return json({ ok: true });
}
async function deleteUser(env, user, tenant, id) {
  requireAdmin(user);
  if (id === user.id) fail(400, 'self', 'Der eigene Zugang kann nicht gelöscht werden.');
  const target = await one(env, 'SELECT * FROM users WHERE id=? AND tenant_id=?', id, tenant.id);
  if (!target) fail(404, 'not_found', 'Zugang nicht gefunden.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM users WHERE id=? AND tenant_id=?').bind(id, tenant.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id),
  ]);
  await audit(env, tenant.id, user, 'zugang_geloescht', id, '');
  return json({ ok: true });
}

// ─── Verwaltung: Termine / Kalender ─────────────────────────────────────────
async function decAppt(env, tenant, row, full = false) {
  const p = await unseal(env, tenant.id, row.cdata);
  const o = {
    id: row.id, code: fmtCode(row.code), date: row.date, start: row.start, dur: row.dur,
    service_id: row.service_id, service: row.service_name, staff_id: row.staff_id, status: row.status, source: row.source,
    deposit_cents: row.deposit_cents, deposit_status: row.deposit_status,
    name: p.name || '', phone: p.phone || '', created_at: row.created_at,
  };
  if (full) { o.email = p.email || ''; o.note = p.note || ''; o.internal = p.internal || ''; o.updated_by = row.updated_by; }
  return o;
}
async function calendar(env, tenant, url) {
  const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : berlinNow().date;
  const to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : addDays(from, 7);
  const rows = await all(env, "SELECT * FROM appointments WHERE tenant_id=? AND date>=? AND date<=? AND status!='abgesagt' ORDER BY date, start", tenant.id, from, to);
  const appts = [];
  for (const r of rows) appts.push(await decAppt(env, tenant, r));
  const blocks = await all(env, 'SELECT * FROM blocks WHERE tenant_id=? AND date_to>=? AND date_from<=?', tenant.id, from, to);
  const staff = (await all(env, 'SELECT * FROM staff WHERE tenant_id=? ORDER BY sort', tenant.id)).map(pubStaff);
  return json({ from, to, appts, blocks, staff });
}
async function listAppointments(env, tenant, url) {
  const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : berlinNow().date;
  const to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : addDays(from, 30);
  const status = STATUSES.includes(url.searchParams.get('status')) ? url.searchParams.get('status') : null;
  const sql = 'SELECT * FROM appointments WHERE tenant_id=? AND date>=? AND date<=?' + (status ? ' AND status=?' : '') + ' ORDER BY date, start';
  const rows = status ? await all(env, sql, tenant.id, from, to, status) : await all(env, sql, tenant.id, from, to);
  const out = [];
  for (const r of rows) out.push(await decAppt(env, tenant, r, true));
  return json({ appts: out });
}
async function searchAppointments(env, tenant, url) {
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
  if (q.length < 2) return json({ appts: [] });
  // Suche entschlüsselt zeilenweise (Daten sind verschlüsselt) → auf jüngste 500 begrenzt
  const rows = await all(env, 'SELECT * FROM appointments WHERE tenant_id=? ORDER BY date DESC LIMIT 500', tenant.id);
  const out = [];
  for (const r of rows) {
    const a = await decAppt(env, tenant, r, true);
    if ((a.name || '').toLowerCase().includes(q) || (a.phone || '').includes(q) || fmtCode(r.code).toLowerCase().includes(q)) out.push(a);
    if (out.length >= 50) break;
  }
  return json({ appts: out });
}
async function createAppointment(request, env, ctx, user, tenant) {
  const input = await body(request);
  const s = await getSettings(env, tenant.id);
  const service = await one(env, 'SELECT * FROM services WHERE id=? AND tenant_id=?', input.service, tenant.id);
  if (!service) fail(400, 'bad_service', 'Leistung wählen.');
  const date = input.date, start = parseInt(input.start, 10);
  if (!isDate(date) || !Number.isFinite(start)) fail(400, 'bad_slot', 'Tag und Uhrzeit wählen.');
  let staffId = String(input.staff || '');
  const staffRow = staffId ? await one(env, 'SELECT id FROM staff WHERE id=? AND tenant_id=?', staffId, tenant.id) : null;
  if (!staffRow) { const first = await one(env, 'SELECT id FROM staff WHERE tenant_id=? AND active=1 ORDER BY sort LIMIT 1', tenant.id); staffId = first ? first.id : ''; }
  const dur = service.dur + service.buffer_min;
  // Admin darf überbuchen? Nein — gleiche Überschneidungsprüfung für den Mitarbeiter, aber ohne Vorlauf/Feiertag.
  const clash = await one(env, "SELECT COUNT(*) n FROM appointments WHERE tenant_id=? AND staff_id=? AND date=? AND status IN ('angefragt','bestaetigt') AND start < ? + ? AND start + dur > ?", tenant.id, staffId, date, start, dur, start);
  if (clash.n > 0 && !input.force) fail(409, 'clash', 'Zu dieser Zeit ist der Mitarbeiter schon belegt. „Trotzdem anlegen“ überbucht bewusst.');
  const c = { name: String(input.name || '').trim().slice(0, 100), phone: String(input.phone || '').trim().slice(0, 30), email: String(input.email || '').trim().toLowerCase().slice(0, 190), note: String(input.note || '').trim().slice(0, 300), internal: String(input.internal || '').trim().slice(0, 300) };
  if (!c.name) fail(400, 'bad_name', 'Bitte einen Namen angeben.');
  const id = crypto.randomUUID(), code = randomCode(), now = Date.now();
  await env.DB.prepare('INSERT INTO appointments (id, tenant_id, code, date, start, dur, service_id, service_name, staff_id, status, source, cdata, has_email, consent, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, tenant.id, code, date, start, dur, service.id, service.name, staffId, 'bestaetigt', 'admin', await seal(env, tenant.id, c), c.email ? 1 : 0, '', now, now, user.name).run();
  await audit(env, tenant.id, user, 'termin_angelegt', id, service.name);
  if (c.email && env.BREVO_API_KEY && input.notify) ctx.waitUntil(mailCustomer(env, tenant, s, c.email, 'bestaetigt', { code, date, start, dur: service.dur, service_name: service.name }).catch(logErr));
  return json({ id, code: fmtCode(code) });
}
async function updateAppointment(request, env, ctx, user, tenant, id) {
  const row = await one(env, 'SELECT * FROM appointments WHERE id=? AND tenant_id=?', id, tenant.id);
  if (!row) fail(404, 'not_found', 'Termin nicht gefunden.');
  const input = await body(request);
  const now = Date.now();
  const fields = [], binds = [];
  if ('status' in input && STATUSES.includes(input.status)) { fields.push('status=?'); binds.push(input.status); }
  if ('staff' in input) { const st = await one(env, 'SELECT id FROM staff WHERE id=? AND tenant_id=?', input.staff, tenant.id); if (st) { fields.push('staff_id=?'); binds.push(st.id); } }
  if ('date' in input && isDate(input.date)) { fields.push('date=?'); binds.push(input.date); }
  if ('start' in input && Number.isFinite(parseInt(input.start, 10))) { fields.push('start=?'); binds.push(parseInt(input.start, 10)); }
  if ('deposit_status' in input && ['none', 'pending', 'paid'].includes(input.deposit_status)) { fields.push('deposit_status=?'); binds.push(input.deposit_status); }
  // Kundendaten aktualisieren (verschlüsselt)
  if (['name', 'phone', 'email', 'note', 'internal'].some(k => k in input)) {
    const p = await unseal(env, tenant.id, row.cdata);
    for (const k of ['name', 'phone', 'email', 'note', 'internal']) if (k in input) p[k] = String(input[k] || '').slice(0, 300);
    fields.push('cdata=?'); binds.push(await seal(env, tenant.id, p));
    fields.push('has_email=?'); binds.push(p.email ? 1 : 0);
  }
  if (!fields.length) return json({ ok: true });
  fields.push('updated_at=?', 'updated_by=?'); binds.push(now, user.name);
  await env.DB.prepare(`UPDATE appointments SET ${fields.join(', ')} WHERE id=? AND tenant_id=?`).bind(...binds, id, tenant.id).run();
  await audit(env, tenant.id, user, 'termin_geaendert', id, input.status || '');
  return json({ ok: true });
}
async function deleteAppointment(env, user, tenant, id) {
  await env.DB.prepare('DELETE FROM appointments WHERE id=? AND tenant_id=?').bind(id, tenant.id).run();
  await audit(env, tenant.id, user, 'termin_geloescht', id, '');
  return json({ ok: true });
}

// Admin: freie Zeiten für manuelles Anlegen (ohne Vorlauf)
async function freeForAdmin(env, tenant, url) {
  const s = await getSettings(env, tenant.id);
  const service = await one(env, 'SELECT * FROM services WHERE id=? AND tenant_id=?', url.searchParams.get('service'), tenant.id);
  if (!service) fail(400, 'bad_service', 'Leistung wählen.');
  const date = isDate(url.searchParams.get('date')) ? url.searchParams.get('date') : berlinNow().date;
  const dur = service.dur + service.buffer_min;
  let staffList = await eligibleStaff(env, tenant, service.id);
  const wantStaff = url.searchParams.get('staff');
  if (wantStaff && wantStaff !== 'any') staffList = staffList.filter(st => st.id === wantStaff);
  const busy = await loadBusy(env, tenant, date, date);
  const slots = freeStartsDetailed({ ...s, skip_holidays: false }, staffList, busy, date, dur, {});
  return json({ date, slots });
}

// ─── Verwaltung: Sperrzeiten ─────────────────────────────────────────────────
async function listBlocks(env, tenant) {
  const rows = await all(env, 'SELECT * FROM blocks WHERE tenant_id=? AND date_to >= ? ORDER BY date_from', tenant.id, berlinNow().date);
  return json({ blocks: rows });
}
async function createBlock(request, env, user, tenant) {
  const input = await body(request);
  if (!isDate(input.date_from) || !isDate(input.date_to) || input.date_to < input.date_from) fail(400, 'bad_date', 'Bitte gültigen Zeitraum angeben.');
  let start = null, stop = null;
  if (input.start && input.stop) {
    if (!/^\d{2}:\d{2}$/.test(input.start) || !/^\d{2}:\d{2}$/.test(input.stop) || toMin(input.stop) <= toMin(input.start)) fail(400, 'bad_time', 'Uhrzeit ist ungültig.');
    start = toMin(input.start); stop = toMin(input.stop);
  }
  let staffId = '';
  if (input.staff) { const st = await one(env, 'SELECT id FROM staff WHERE id=? AND tenant_id=?', input.staff, tenant.id); if (st) staffId = st.id; }
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO blocks (id, tenant_id, staff_id, date_from, date_to, start, stop, reason, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, tenant.id, staffId, input.date_from, input.date_to, start, stop, String(input.reason || '').slice(0, 100), Date.now()).run();
  await audit(env, tenant.id, user, 'sperre_neu', id, input.reason || '');
  return json({ id });
}
async function deleteBlock(env, user, tenant, id) {
  await env.DB.prepare('DELETE FROM blocks WHERE id=? AND tenant_id=?').bind(id, tenant.id).run();
  await audit(env, tenant.id, user, 'sperre_geloescht', id, '');
  return json({ ok: true });
}

// ─── Verwaltung: Übersicht ───────────────────────────────────────────────────
async function summary(env, tenant) {
  const today = berlinNow().date;
  const n = await one(env, "SELECT COUNT(*) c FROM appointments WHERE tenant_id=? AND date=? AND status IN ('angefragt','bestaetigt')", tenant.id, today);
  const week = await one(env, "SELECT COUNT(*) c FROM appointments WHERE tenant_id=? AND date>=? AND date<=? AND status IN ('angefragt','bestaetigt')", tenant.id, today, addDays(today, 6));
  const next = await all(env, "SELECT * FROM appointments WHERE tenant_id=? AND (date>? OR (date=? AND start>=?)) AND status IN ('angefragt','bestaetigt') ORDER BY date, start LIMIT 8", tenant.id, today, today, berlinNow().min);
  const list = [];
  for (const r of next) list.push(await decAppt(env, tenant, r));
  return json({ today: n.c, week: week.c, next: list, tenant: publicTenant(tenant) });
}

// ─── Betreiber (Super-Admin) ────────────────────────────────────────────────
async function operatorSetup(request, env) {
  const input = await body(request);
  await limitOrFail(env, await ipKey(request, 'opsetup', env), 10, 15 * 60 * 1000);
  if (!env.OPERATOR_SETUP_CODE) fail(403, 'no_setup', 'Secret OPERATOR_SETUP_CODE fehlt.');
  if (!safeEqual(await sha256(String(input.setup_code || '')), await sha256(env.OPERATOR_SETUP_CODE))) fail(403, 'bad_setup', 'Einrichtungscode stimmt nicht.');
  if ((await one(env, 'SELECT COUNT(*) n FROM operators')).n > 0) fail(409, 'done', 'Betreiber-Zugang existiert schon.');
  const username = cleanUsername(input.username);
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) fail(400, 'bad_username', 'Benutzername ungültig.');
  checkNewPassword(input.password);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO operators (id, username, name, pw, created_at) VALUES (?,?,?,?,?)')
    .bind(id, username, String(input.name || username).slice(0, 60), await hashPassword(input.password), Date.now()).run();
  return json({ ok: true });
}
async function operatorLogin(request, env) {
  const input = await body(request);
  await limitOrFail(env, await ipKey(request, 'oplogin', env), 20, 15 * 60 * 1000);
  const op = await one(env, 'SELECT * FROM operators WHERE username=?', cleanUsername(input.username));
  if (!op || !(await checkPassword(String(input.password || ''), op.pw))) fail(401, 'bad_login', 'Login falsch.');
  const token = randomToken(); const now = Date.now();
  await env.DB.prepare('INSERT INTO operator_sessions (token_hash, op_id, created_at, expires_at) VALUES (?,?,?,?)').bind(await sha256(token), op.id, now, now + 7 * DAY_MS).run();
  await env.DB.prepare('UPDATE operators SET last_login=? WHERE id=?').bind(now, op.id).run();
  return json({ token, name: op.name });
}
async function requireOperator(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) fail(401, 'no_session', 'Bitte anmelden.');
  const row = await one(env, 'SELECT o.* FROM operator_sessions s JOIN operators o ON o.id = s.op_id WHERE s.token_hash=? AND s.expires_at > ?', await sha256(token), Date.now());
  if (!row) fail(401, 'no_session', 'Sitzung abgelaufen.');
  return row;
}
async function operatorTenants(env, url) {
  const q = String(url.searchParams.get('q') || '').toLowerCase().trim();
  let rows = await all(env, 'SELECT * FROM tenants ORDER BY created_at DESC LIMIT 500');
  if (q) rows = rows.filter(t => t.slug.includes(q) || t.name.toLowerCase().includes(q) || t.email.toLowerCase().includes(q));
  const out = [];
  for (const t of rows) {
    const c = (await one(env, "SELECT COUNT(*) n FROM appointments WHERE tenant_id=? AND status IN ('angefragt','bestaetigt') AND date>=?", t.id, berlinNow().date)).n;
    out.push({ ...publicTenant(t), created_at: t.created_at, upcoming: c });
  }
  return json({ tenants: out });
}
async function operatorStats(env) {
  const total = (await one(env, 'SELECT COUNT(*) n FROM tenants')).n;
  const byStatus = await all(env, 'SELECT status, COUNT(*) n FROM tenants GROUP BY status');
  const byPlan = await all(env, 'SELECT plan, COUNT(*) n FROM tenants GROUP BY plan');
  const appts = (await one(env, 'SELECT COUNT(*) n FROM appointments')).n;
  return json({ tenants: total, appts, byStatus, byPlan });
}
async function operatorUpdateTenant(request, env, op, id) {
  const input = await body(request);
  const t = await one(env, 'SELECT * FROM tenants WHERE id=?', id);
  if (!t) fail(404, 'not_found', 'Betrieb nicht gefunden.');
  const status = TENANT_STATES.includes(input.status) ? input.status : t.status;
  const plan = PLANS.includes(input.plan) ? input.plan : t.plan;
  let trial = t.trial_ends;
  if ('extend_days' in input) trial = Date.now() + (parseInt(input.extend_days, 10) || 0) * DAY_MS;
  await env.DB.prepare('UPDATE tenants SET status=?, plan=?, trial_ends=?, updated_at=? WHERE id=?').bind(status, plan, trial, Date.now(), id).run();
  await audit(env, id, { id: op.id, name: 'Betreiber:' + op.name }, 'operator_update', '', status + '/' + plan);
  return json({ ok: true });
}

// ─── Abrechnung (Stripe) ──────────────────────────────────────────────────────
const PLAN_PRICE_ENV = { basis: 'STRIPE_PRICE_BASIS', plus: 'STRIPE_PRICE_PLUS', pro: 'STRIPE_PRICE_PRO' };
async function billingStatus(env, tenant) {
  const trialLeft = tenant.status === 'trial' && tenant.trial_ends ? Math.max(0, Math.ceil((tenant.trial_ends - Date.now()) / DAY_MS)) : 0;
  return json({ configured: !!env.STRIPE_SECRET, plan: tenant.plan, status: tenant.status, trial_days_left: trialLeft, plans: PLANS });
}
async function stripeForm(env, path, params) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json();
  if (!res.ok) fail(502, 'stripe', (data.error && data.error.message) || 'Stripe-Fehler.');
  return data;
}
async function billingCheckout(request, env, user, tenant) {
  requireAdmin(user);
  if (!env.STRIPE_SECRET) fail(400, 'no_stripe', 'Abrechnung ist noch nicht eingerichtet.');
  const input = await body(request);
  const plan = PLANS.includes(input.plan) ? input.plan : 'basis';
  const priceId = env[PLAN_PRICE_ENV[plan]];
  if (!priceId) fail(400, 'no_price', `Für Paket „${plan}“ ist kein Preis hinterlegt.`);
  let customer = tenant.stripe_customer;
  if (!customer) {
    const cu = await stripeForm(env, 'customers', { email: tenant.email, name: tenant.name, 'metadata[tenant_id]': tenant.id, 'metadata[slug]': tenant.slug });
    customer = cu.id;
    await env.DB.prepare('UPDATE tenants SET stripe_customer=? WHERE id=?').bind(customer, tenant.id).run();
  }
  const base = (env.APP_ORIGINS || 'https://app.example.com').split(',')[0].trim();
  const session = await stripeForm(env, 'checkout/sessions', {
    mode: 'subscription', customer,
    'line_items[0][price]': priceId, 'line_items[0][quantity]': '1',
    'subscription_data[metadata][tenant_id]': tenant.id, 'metadata[tenant_id]': tenant.id, 'metadata[plan]': plan,
    success_url: `${base}/verwaltung/?bezahlt=1`, cancel_url: `${base}/verwaltung/?abo=abgebrochen`,
    allow_promotion_codes: 'true',
  });
  return json({ url: session.url });
}
async function stripeWebhook(request, env, ctx) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ ok: true, skipped: true });
  const sig = request.headers.get('Stripe-Signature') || '';
  const payload = await request.text();
  if (!(await stripeVerify(env.STRIPE_WEBHOOK_SECRET, payload, sig))) fail(400, 'bad_sig', 'Signatur ungültig.');
  let evt; try { evt = JSON.parse(payload); } catch { fail(400, 'bad_json', 'x'); }
  const obj = evt.data && evt.data.object || {};
  const setTenant = async (tid, patch) => {
    if (!tid) return;
    const sets = Object.keys(patch).map((k, i) => `${k}=?${i + 1}`).join(', ');
    await env.DB.prepare(`UPDATE tenants SET ${sets}, updated_at=?${Object.keys(patch).length + 1} WHERE id=?${Object.keys(patch).length + 2}`)
      .bind(...Object.values(patch), Date.now(), tid).run();
  };
  if (evt.type === 'checkout.session.completed') {
    const tid = obj.metadata && obj.metadata.tenant_id;
    await setTenant(tid, { status: 'active', plan: (obj.metadata && obj.metadata.plan) || 'basis', stripe_sub: obj.subscription || '', stripe_customer: obj.customer || '' });
  } else if (evt.type === 'customer.subscription.updated' || evt.type === 'customer.subscription.deleted') {
    const tid = obj.metadata && obj.metadata.tenant_id;
    const active = evt.type !== 'customer.subscription.deleted' && ['active', 'trialing', 'past_due'].includes(obj.status);
    const status = evt.type === 'customer.subscription.deleted' ? 'canceled' : (obj.status === 'past_due' ? 'past_due' : (active ? 'active' : 'canceled'));
    const t = await one(env, 'SELECT id FROM tenants WHERE stripe_sub=? OR id=?', obj.id || '', tid || '');
    if (t) await setTenant(t.id, { status });
  }
  return json({ received: true });
}
async function stripeVerify(secret, payload, sigHeader) {
  const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')));
  if (!parts.t || !parts.v1) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(parts.t + '.' + payload));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return safeEqual(hex, parts.v1);
}

// ─── E-Mail (Brevo) + WhatsApp/SMS ─────────────────────────────────────────────
async function brevo(env, payload) {
  if (!env.BREVO_API_KEY) return;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) logErr(new Error('Brevo ' + res.status + ' ' + (await res.text()).slice(0, 200)));
}
const SENDER = env => ({ name: 'TerminPilot', email: (env.MAIL_FROM || 'termine@terminpilot.app') });
function apptText(tenant, appt) {
  return `${appt.service_name || appt.service || 'Termin'} am ${deDate(appt.date)} um ${hhmm(appt.start)} Uhr bei ${tenant.name}`;
}
async function mailCustomer(env, tenant, s, to, kind, appt) {
  const sub = kind === 'bestaetigt' ? `Termin bestätigt – ${tenant.name}` : `Termin abgesagt – ${tenant.name}`;
  const t = apptText(tenant, appt);
  const code = appt.code ? `\nBuchungscode: ${fmtCode(typeof appt.code === 'string' && appt.code.includes('-') ? normCode(appt.code) : appt.code)}` : '';
  const body = kind === 'bestaetigt'
    ? `Ihr Termin ist bestätigt:\n\n${t}${code}\n\nMüssen Sie absagen, nutzen Sie den Buchungscode auf der Buchungsseite oder rufen Sie an${tenant.phone ? ': ' + tenant.phone : ''}.`
    : `Ihr Termin wurde abgesagt:\n\n${t}\n\nGerne können Sie online einen neuen Termin buchen.`;
  await brevo(env, {
    sender: SENDER(env), to: [{ email: to }], replyTo: tenant.email ? { email: tenant.email, name: tenant.name } : undefined,
    subject: sub, textContent: body + `\n\n— ${tenant.name}`,
  });
}
async function mailSignup(env, to, name, slug) {
  await brevo(env, {
    sender: SENDER(env), to: [{ email: to }], subject: 'Willkommen bei TerminPilot',
    textContent: `Hallo,\n\nIhr Buchungskonto für „${name}“ ist angelegt.\n\nIhre Buchungsseite: Betriebs-Adresse „${slug}“.\nVerwaltung: oben rechts anmelden.\n\nViel Erfolg!\n— TerminPilot`,
  });
}
// WhatsApp/SMS über frei konfigurierbaren EU-Provider (WA_API_URL bekommt JSON {to, text})
async function sendWa(env, to, text) {
  if (!env.WA_API_URL) return false;
  try {
    const res = await fetch(env.WA_API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(env.WA_API_KEY ? { Authorization: 'Bearer ' + env.WA_API_KEY } : {}) },
      body: JSON.stringify({ to, text }),
    });
    return res.ok;
  } catch (e) { logErr(e); return false; }
}

// ─── Cron: Erinnerungen + Aufräumen ────────────────────────────────────────────
async function dueReminders(env) {
  // am Vortag erinnern: Termine von morgen, noch nicht erinnert
  const tomorrow = addDays(berlinNow().date, 1);
  const rows = await all(env, "SELECT * FROM appointments WHERE date=? AND status='bestaetigt' AND (reminded & 1)=0 LIMIT 200", tomorrow);
  for (const r of rows) {
    const tenant = await one(env, 'SELECT * FROM tenants WHERE id=?', r.tenant_id);
    if (!tenant) continue;
    const s = await getSettings(env, r.tenant_id);
    if (!s.reminder) { await env.DB.prepare('UPDATE appointments SET reminded = reminded | 1 WHERE id=?').bind(r.id).run(); continue; }
    const p = await unseal(env, r.tenant_id, r.cdata);
    const txt = `Erinnerung: ${apptText(tenant, r)}.`;
    if (p.email && env.BREVO_API_KEY) await brevo(env, { sender: SENDER(env), to: [{ email: p.email }], replyTo: tenant.email ? { email: tenant.email } : undefined, subject: `Erinnerung an Ihren Termin – ${tenant.name}`, textContent: txt }).catch(logErr);
    if (s.reminder_wa && (tenant.plan === 'plus' || tenant.plan === 'pro') && p.phone) await sendWa(env, p.phone, txt);
    await env.DB.prepare('UPDATE appointments SET reminded = reminded | 1 WHERE id=?').bind(r.id).run();
  }
}
async function daily(env) {
  await cleanupSessions(env);
  // alte Termine je Tenant nach retention_days löschen
  const tenants = await all(env, 'SELECT id FROM tenants');
  for (const t of tenants) {
    const s = await getSettings(env, t.id);
    const cutoff = addDays(berlinNow().date, -s.retention_days);
    await env.DB.prepare('DELETE FROM appointments WHERE tenant_id=? AND date < ?').bind(t.id, cutoff).run();
  }
  // abgelaufene Trials auf past_due? Nein — Buchung sperrt via tenantUsable; Status bleibt für Betreiber sichtbar.
  await env.DB.prepare('DELETE FROM audit WHERE at < ?').bind(Date.now() - 180 * DAY_MS).run();
}
