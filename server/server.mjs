// Startet TerminPilot auf einem Hetzner-Server: HTTP auf 127.0.0.1 (Caddy davor = HTTPS),
// SQLite statt Cloudflare D1 (gleiche Schnittstelle, server.js bleibt unverändert),
// serviert die statischen Web-Dateien aus ../web, Zeitplan (Erinnerungen + Aufräumen) + nächtliche Sicherung.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from './server.js';

const DATA_DIR = process.env.DATA_DIR || '/var/lib/terminpilot';
const BACKUP_DIR = process.env.BACKUP_DIR || '/var/backups/terminpilot';
const WEB_DIR = process.env.WEB_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'web');
const BACKUP_DAYS = 14;
const PORT = +(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 128 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'terminpilot.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

// Dieselbe Schnittstelle wie Cloudflare D1, damit server.js unverändert bleibt
const clean = a => a.map(x => x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x);
class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, clean(a)); }
  runSync() { const r = db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
  async first() { const r = db.prepare(this.sql).get(...this.args); return r ? { ...r } : null; }
  async all() { return { results: db.prepare(this.sql).all(...this.args).map(r => ({ ...r })) }; }
  async run() { return this.runSync(); }
}
const DB = {
  prepare: sql => new Stmt(sql),
  async batch(list) {
    db.exec('BEGIN');
    try { const r = list.map(s => s.runSync()); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  },
};

const env = {
  DB,
  MASTER_KEY: process.env.MASTER_KEY,
  OPERATOR_SETUP_CODE: process.env.OPERATOR_SETUP_CODE,
  SIGNUP_ENABLED: process.env.SIGNUP_ENABLED || '1',
  APP_ORIGINS: process.env.APP_ORIGINS || undefined,
  MAIL_FROM: process.env.MAIL_FROM || undefined,
  BREVO_API_KEY: process.env.BREVO_API_KEY || undefined,
  WA_API_URL: process.env.WA_API_URL || undefined,
  WA_API_KEY: process.env.WA_API_KEY || undefined,
  STRIPE_SECRET: process.env.STRIPE_SECRET || undefined,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || undefined,
  STRIPE_PRICE_BASIS: process.env.STRIPE_PRICE_BASIS || undefined,
  STRIPE_PRICE_PLUS: process.env.STRIPE_PRICE_PLUS || undefined,
  STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO || undefined,
};
if (!env.MASTER_KEY) { console.error('MASTER_KEY fehlt in /etc/terminpilot.env'); process.exit(1); }

const nebenbei = p => Promise.resolve(p).catch(e => console.error('Hintergrund:', e && e.stack || e));

// ─── Statische Web-Dateien ───────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };
function safeJoin(root, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/\0/g, '');
  const p = path.normalize(path.join(root, clean));
  if (!p.startsWith(path.normalize(root))) return null; // kein Verzeichnis-Ausbruch
  return p;
}
function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  let file = safeJoin(WEB_DIR, urlPath);
  if (!file) { res.writeHead(403).end(); return; }
  try {
    let stat = fs.existsSync(file) ? fs.statSync(file) : null;
    if (stat && stat.isDirectory()) { file = path.join(file, 'index.html'); stat = fs.existsSync(file) ? fs.statSync(file) : null; }
    if (!stat && !path.extname(file)) { const h = file + '.html'; if (fs.existsSync(h)) { file = h; stat = fs.statSync(h); } }
    if (!stat) { // 404 → Landing
      const f404 = path.join(WEB_DIR, '404.html');
      if (fs.existsSync(f404)) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(f404)); return; }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Nicht gefunden'); return;
    }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'x-content-type-options': 'nosniff' };
    if (urlPath === '/buchen.html') headers['content-security-policy'] = 'frame-ancestors *'; // Embed erlaubt
    else if (ext === '.html') headers['x-frame-options'] = 'SAMEORIGIN';
    if (['.css', '.js', '.woff2', '.png', '.svg'].includes(ext)) headers['cache-control'] = 'public, max-age=3600';
    res.writeHead(200, headers);
    res.end(fs.readFileSync(file));
  } catch (e) { console.error('static:', e && e.message); res.writeHead(500).end(); }
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = req.url || '/';
    // Nicht-API-Anfragen: statische Dateien ausliefern
    if (!url.startsWith('/api/')) { if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res); res.writeHead(405).end(); return; }

    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    headers.set('cf-connecting-ip', ip);
    const request = new Request(`http://${req.headers.host || 'localhost'}${url}`, {
      method: req.method, headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const out = await worker.fetch(request, env, { waitUntil: nebenbei });
    const h = Object.fromEntries(out.headers);
    h['x-content-type-options'] = 'nosniff';
    res.writeHead(out.status, h);
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    console.error(e && e.stack || e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"server"}');
  }
});
server.listen(PORT, HOST, () => console.log(`TerminPilot läuft auf ${HOST}:${PORT}`));

// ─── Zeitplan (deutsche Zeit): alle 5 Min Erinnerungen + ~03:00 Aufräumen; 03:30 Sicherung ───
function berlin() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24 };
}
const merker = path.join(DATA_DIR, 'zeitplan.json');
let zuletzt = {};
try { zuletzt = JSON.parse(fs.readFileSync(merker, 'utf8')); } catch { zuletzt = {}; }
const merke = (k, d) => { zuletzt[k] = d; fs.writeFileSync(merker, JSON.stringify(zuletzt)); };

function sicherung(date) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ziel = path.join(BACKUP_DIR, `terminpilot-${date}.db`);
  if (fs.existsSync(ziel)) fs.unlinkSync(ziel);
  db.exec(`VACUUM INTO '${ziel}'`);
  fs.chmodSync(ziel, 0o600);
  const grenze = Date.now() - BACKUP_DAYS * 86400000;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const p = path.join(BACKUP_DIR, f);
    if (/^terminpilot-\d{4}-\d{2}-\d{2}\.db$/.test(f) && fs.statSync(p).mtimeMs < grenze) fs.unlinkSync(p);
  }
  console.log('Sicherung', ziel);
}

async function zeitplan() {
  const { date, hour } = berlin();
  try {
    // server.js' scheduled() kümmert sich selbst um Erinnerungen (jede Runde) + Aufräumen (~03:00)
    const warten = [];
    await worker.scheduled({}, env, { waitUntil: p => warten.push(nebenbei(p)) });
    await Promise.all(warten);
    if (hour >= 3 && zuletzt.sicherung !== date) { merke('sicherung', date); sicherung(date); }
  } catch (e) { console.error('Zeitplan:', e && e.stack || e); }
}
setTimeout(zeitplan, 5000);
setInterval(zeitplan, 5 * 60 * 1000);

function ende() { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', ende);
process.on('SIGINT', ende);
