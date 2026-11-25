// TerminPilot — gemeinsamer API-Client (öffentliche Seiten + Verwaltung)
// Setze window.TP_API vor dem Laden, falls die API woanders liegt.
(function () {
  const API = (window.TP_API || 'https://api.terminpilot.app').replace(/\/+$/, '');
  window.TP_API = API;

  // Betriebs-Adresse (Tenant) aus ?b= oder Subdomain
  function tenantSlug() {
    const q = new URLSearchParams(location.search).get('b');
    if (q) return q.toLowerCase();
    const parts = location.hostname.split('.');
    if (parts.length >= 3 && !['www', 'app', 'api'].includes(parts[0])) return parts[0].toLowerCase();
    return '';
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}) };
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    if (opts.tenant) headers['X-Tenant'] = opts.tenant;
    const res = await fetch(API + path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.message || 'Fehler'); e.code = data.error; e.status = res.status; throw e; }
    return data;
  }

  const euro = c => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
  const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const TAGE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const TAGE_L = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  function deDate(d, long) {
    const wd = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).getUTCDay();
    return `${long ? TAGE_L[wd] : TAGE[wd]}, ${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  window.TP = { api, tenantSlug, euro, hhmm, deDate, esc, TAGE, TAGE_L };
})();
