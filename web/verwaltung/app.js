// TerminPilot — Verwaltungs-App
(function () {
  const { api: rawApi, euro, hhmm, deDate, esc, TAGE } = window.TP;
  const $ = s => document.querySelector(s);
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const LS = 'tp_admin';
  let auth = null;      // {token, slug, user, tenant}
  let cache = { services: null, staff: null };

  function loadAuth() { try { auth = JSON.parse(localStorage.getItem(LS) || 'null'); } catch { auth = null; } }
  function saveAuth() { localStorage.setItem(LS, JSON.stringify(auth)); }
  function clearAuth() { localStorage.removeItem(LS); auth = null; }

  async function api(path, opts = {}) {
    try {
      return await rawApi(path, { ...opts, token: auth && auth.token, tenant: auth && auth.slug });
    } catch (e) {
      if (e.status === 401) { clearAuth(); showLogin('Sitzung abgelaufen. Bitte neu anmelden.'); }
      throw e;
    }
  }

  function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, 3000); }

  function money(euroStr) { const n = Math.round(parseFloat(String(euroStr).replace(',', '.')) * 100); return Number.isFinite(n) ? n : 0; }
  const toEuroInput = c => c > 0 ? (c / 100).toFixed(2).replace('.', ',') : '';

  // ─── Login ───────────────────────────────────────────────────────────────
  function showLogin(msg) {
    $('#appView').hidden = true; $('#loginView').hidden = false;
    $('#loginMsg').innerHTML = msg ? '<div class="msg info">' + esc(msg) + '</div>' : '';
    if (auth && auth.slug) $('#lSlug').value = auth.slug;
  }
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = 'Anmelden …';
    $('#loginMsg').innerHTML = '';
    try {
      const r = await rawApi('/api/admin/login', { body: { slug: $('#lSlug').value.trim().toLowerCase(), username: $('#lUser').value, password: $('#lPass').value, device: navigator.userAgent.slice(0, 60) } });
      auth = { token: r.token, slug: r.tenant.slug, user: r.user, tenant: r.tenant }; saveAuth();
      await startApp();
    } catch (err) {
      $('#loginMsg').innerHTML = '<div class="msg err">' + esc(err.message) + '</div>';
      btn.disabled = false; btn.textContent = 'Anmelden';
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch {}
    clearAuth(); location.reload();
  });

  // ─── App-Start ─────────────────────────────────────────────────────────────
  async function startApp() {
    $('#loginView').hidden = true; $('#appView').hidden = false;
    try {
      const me = await api('/api/admin/me');
      auth.user = me.user; auth.tenant = me.tenant; auth.slug = me.tenant.slug; saveAuth();
    } catch { return; }
    $('#sideBiz').textContent = auth.tenant.name;
    const bookUrl = location.origin + '/buchen.html?b=' + encodeURIComponent(auth.slug);
    $('#bookLink').href = bookUrl;
    renderBanner();
    // Nur-Team sieht keine Inhaber-Bereiche
    if (auth.user.role !== 'admin') document.querySelectorAll('.menu button').forEach(b => { if (['services', 'staff', 'settings', 'team', 'billing'].includes(b.dataset.view)) b.style.display = 'none'; });
    go('dash');
  }

  function renderBanner() {
    const b = $('#banner'); b.innerHTML = '';
    const t = auth.tenant;
    if (t.status === 'trial' && t.trial_ends) {
      const days = Math.max(0, Math.ceil((t.trial_ends - Date.now()) / 86400000));
      b.innerHTML = `<div class="msg ${days <= 3 ? 'err' : 'info'}" style="margin:0 24px">Testzeitraum: noch ${days} Tag(e). <a href="#" data-view="billing">Jetzt Abo wählen</a>, damit die Buchung aktiv bleibt.</div>`;
    } else if (t.status === 'past_due') {
      b.innerHTML = `<div class="msg err" style="margin:0 24px">Zahlung ausstehend – die Online-Buchung ist pausiert. <a href="#" data-view="billing">Abo prüfen</a>.</div>`;
    } else if (t.status === 'canceled') {
      b.innerHTML = `<div class="msg err" style="margin:0 24px">Kein aktives Abo – die Online-Buchung ist aus. <a href="#" data-view="billing">Reaktivieren</a>.</div>`;
    }
    b.querySelectorAll('a[data-view]').forEach(a => a.onclick = e => { e.preventDefault(); go(a.dataset.view); });
  }

  // ─── Router ──────────────────────────────────────────────────────────────
  const TITLES = { dash: 'Übersicht', calendar: 'Kalender', appts: 'Termine', services: 'Leistungen', staff: 'Mitarbeiter', blocks: 'Sperrzeiten', settings: 'Einstellungen', team: 'Team', billing: 'Abo' };
  const VIEWS = {};
  function go(view) {
    document.querySelectorAll('.menu button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
    $('#viewTitle').textContent = TITLES[view] || '';
    $('#appView').classList.remove('open');
    const v = $('#view'); v.innerHTML = '<p class="muted">Lade …</p>';
    (VIEWS[view] || VIEWS.dash)(v).catch(e => v.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>');
  }
  document.querySelectorAll('.menu button').forEach(b => b.onclick = () => go(b.dataset.view));
  $('#hamb').onclick = () => $('#appView').classList.toggle('open');
  $('#scrim').onclick = () => $('#appView').classList.remove('open');

  async function getServices(force) { if (!cache.services || force) cache.services = (await api('/api/admin/services')).services; return cache.services; }
  async function getStaff(force) { if (!cache.staff || force) cache.staff = (await api('/api/admin/staff')).staff; return cache.staff; }
  const staffName = (list, id) => (list.find(s => s.id === id) || { name: '—' }).name;
  const staffColor = (list, id) => (list.find(s => s.id === id) || { color: '#999' }).color;
  const statusChip = s => ({ bestaetigt: '<span class="chip ok">bestätigt</span>', angefragt: '<span class="chip warn">angefragt</span>', abgesagt: '<span class="chip off">abgesagt</span>', erledigt: '<span class="chip">erledigt</span>', nicht_erschienen: '<span class="chip off">nicht da</span>' }[s] || '');

  // ─── Übersicht ─────────────────────────────────────────────────────────────
  VIEWS.dash = async v => {
    const s = await api('/api/admin/summary');
    const staff = await getStaff();
    const bookUrl = location.origin + '/buchen.html?b=' + encodeURIComponent(auth.slug);
    const embed = `<div id="terminpilot"></div>\n<script src="${location.origin}/embed.js" data-betrieb="${esc(auth.slug)}"><\/script>`;
    v.innerHTML = `
      <div class="stats">
        <div class="stat"><div class="n">${s.today}</div><div class="l">Termine heute</div></div>
        <div class="stat"><div class="n">${s.week}</div><div class="l">diese Woche</div></div>
        <div class="stat"><div class="n">${staff.filter(x => x.active).length}</div><div class="l">aktive Mitarbeiter</div></div>
      </div>
      <div class="panel-card">
        <h2 class="sec">Nächste Termine</h2>
        <div class="rows" id="nextRows"></div>
      </div>
      <div class="panel-card">
        <h2 class="sec">Buchungsseite teilen</h2>
        <p class="muted">Link für Kunden, Social Media oder QR-Code:</p>
        <div class="toolbar"><input class="grow" value="${esc(bookUrl)}" readonly id="bookInput"><button class="btn sm" id="copyLink">Kopieren</button><a class="btn ghost sm" href="${esc(bookUrl)}" target="_blank">Öffnen</a></div>
        <p class="muted" style="margin-top:14px">Zum Einbetten auf der eigenen Website:</p>
        <textarea readonly id="embedCode" style="font-family:ui-monospace,monospace;font-size:.82rem;min-height:70px">${esc(embed)}</textarea>
        <button class="btn ghost sm" id="copyEmbed" style="margin-top:8px">Einbett-Code kopieren</button>
      </div>`;
    const rows = $('#nextRows');
    if (!s.next.length) rows.innerHTML = '<p class="empty-state">Keine anstehenden Termine.</p>';
    else for (const a of s.next) rows.appendChild(apptRow(a, staff, false));
    $('#copyLink').onclick = () => { navigator.clipboard.writeText(bookUrl); toast('Link kopiert'); };
    $('#copyEmbed').onclick = () => { navigator.clipboard.writeText(embed); toast('Einbett-Code kopiert'); };
  };

  function apptRow(a, staff, withActions) {
    const r = el('div', 'row');
    r.innerHTML = `<div class="time">${hhmm(a.start)}</div>
      <div class="main"><div class="nm">${esc(a.name || '—')} ${statusChip(a.status)}</div>
      <div class="sub"><span class="dot-staff" style="background:${staffColor(staff, a.staff_id)}"></span> ${esc(a.service)} · ${deDate(a.date)} · ${esc(staffName(staff, a.staff_id))}${a.phone ? ' · ' + esc(a.phone) : ''}</div></div>`;
    if (withActions) {
      const acts = el('div', 'acts');
      acts.innerHTML = '<button class="iconbtn" title="Bearbeiten">✎</button>';
      acts.querySelector('button').onclick = () => editAppt(a, staff);
      r.appendChild(acts);
    } else r.style.cursor = 'pointer', r.onclick = () => editAppt(a, staff);
    return r;
  }

  // ─── Kalender ──────────────────────────────────────────────────────────────
  let calFrom = null;
  VIEWS.calendar = async v => {
    const staff = await getStaff();
    if (!calFrom) calFrom = todayStr();
    const to = addDays(calFrom, 6);
    const data = await api(`/api/admin/calendar?from=${calFrom}&to=${to}`);
    v.innerHTML = `
      <div class="toolbar">
        <button class="btn ghost sm" id="prevWk">← Woche</button>
        <button class="btn ghost sm" id="todayBtn">Heute</button>
        <button class="btn ghost sm" id="nextWk">Woche →</button>
        <div class="grow"></div>
        <button class="btn sm" id="addAppt">+ Termin</button>
      </div>
      <div id="calDays"></div>`;
    const days = $('#calDays');
    const byDate = {};
    data.appts.forEach(a => (byDate[a.date] ||= []).push(a));
    for (let i = 0; i < 7; i++) {
      const d = addDays(calFrom, i);
      const list = (byDate[d] || []).sort((a, b) => a.start - b.start);
      const card = el('div', 'panel-card');
      card.innerHTML = `<h2 class="sec">${deDate(d, true)} <span class="muted" style="font-weight:500">· ${list.length} Termin(e)</span></h2>`;
      const rows = el('div', 'rows');
      if (!list.length) rows.innerHTML = '<p class="muted" style="font-size:.9rem">frei</p>';
      else list.forEach(a => rows.appendChild(apptRow(a, staff, true)));
      card.appendChild(rows); days.appendChild(card);
    }
    $('#prevWk').onclick = () => { calFrom = addDays(calFrom, -7); go('calendar'); };
    $('#nextWk').onclick = () => { calFrom = addDays(calFrom, 7); go('calendar'); };
    $('#todayBtn').onclick = () => { calFrom = todayStr(); go('calendar'); };
    $('#addAppt').onclick = () => editAppt(null, staff);
  };

  // ─── Termine (Liste + Suche) ────────────────────────────────────────────────
  VIEWS.appts = async v => {
    const staff = await getStaff();
    v.innerHTML = `
      <div class="toolbar">
        <input class="grow" id="searchBox" placeholder="Suche: Name, Telefon oder Buchungscode">
        <select id="statusFilter"><option value="">alle Status</option><option value="bestaetigt">bestätigt</option><option value="erledigt">erledigt</option><option value="nicht_erschienen">nicht erschienen</option><option value="abgesagt">abgesagt</option></select>
        <button class="btn sm" id="addAppt2">+ Termin</button>
      </div>
      <div id="apptList" class="rows"></div>`;
    const list = $('#apptList');
    async function load() {
      const q = $('#searchBox').value.trim();
      const status = $('#statusFilter').value;
      list.innerHTML = '<p class="muted">Lade …</p>';
      let data;
      if (q.length >= 2) data = await api('/api/admin/search?q=' + encodeURIComponent(q));
      else data = await api('/api/admin/appointments?from=' + todayStr() + '&to=' + addDays(todayStr(), 60) + (status ? '&status=' + status : ''));
      let appts = data.appts;
      if (q.length >= 2 && status) appts = appts.filter(a => a.status === status);
      list.innerHTML = '';
      if (!appts.length) { list.innerHTML = '<p class="empty-state">Keine Termine gefunden.</p>'; return; }
      appts.forEach(a => list.appendChild(apptRow(a, staff, true)));
    }
    let t; $('#searchBox').oninput = () => { clearTimeout(t); t = setTimeout(load, 300); };
    $('#statusFilter').onchange = load;
    $('#addAppt2').onclick = () => editAppt(null, staff);
    load();
  };

  // Termin anlegen / bearbeiten (Modal)
  async function editAppt(a, staff) {
    const services = await getServices();
    const isNew = !a;
    const body = `
      <div class="field"><label>Name</label><input id="m_name" value="${esc(a ? a.name : '')}"></div>
      <div class="mrow">
        <div class="field"><label>Telefon</label><input id="m_phone" value="${esc(a ? a.phone : '')}"></div>
        <div class="field"><label>E-Mail</label><input id="m_email" value="${esc(a ? (a.email || '') : '')}"></div>
      </div>
      <div class="mrow">
        <div class="field"><label>Leistung</label><select id="m_service">${services.map(s => `<option value="${s.id}" data-dur="${s.dur}" ${a && a.service_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Mitarbeiter</label><select id="m_staff">${staff.map(s => `<option value="${s.id}" ${a && a.staff_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      </div>
      <div class="mrow">
        <div class="field"><label>Datum</label><input id="m_date" type="date" value="${a ? a.date : todayStr()}"></div>
        <div class="field"><label>Uhrzeit</label><input id="m_time" type="time" value="${a ? hhmm(a.start) : '10:00'}"></div>
      </div>
      <div class="field"><label>Notiz (Kunde)</label><textarea id="m_note">${esc(a ? (a.note || '') : '')}</textarea></div>
      <div class="field"><label>Interne Notiz</label><textarea id="m_internal">${esc(a ? (a.internal || '') : '')}</textarea></div>
      ${a ? `<div class="field"><label>Status</label><select id="m_status">${['bestaetigt', 'erledigt', 'nicht_erschienen', 'abgesagt', 'angefragt'].map(s => `<option value="${s}" ${a.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>` : ''}
      ${isNew ? '<label class="checkrow" style="font-weight:500"><input type="checkbox" id="m_notify"> Kundin/Kunde per E-Mail benachrichtigen</label>' : ''}
    `;
    const extraBtns = a ? '<button class="btn ghost" id="m_del" style="margin-right:auto;color:var(--err)">Löschen</button>' : '';
    openModal(isNew ? 'Termin anlegen' : 'Termin bearbeiten', body, async close => {
      const dateV = $('#m_date').value, timeV = $('#m_time').value;
      const start = timeV ? parseInt(timeV.slice(0, 2)) * 60 + parseInt(timeV.slice(3, 5)) : 0;
      const payload = { service: $('#m_service').value, staff: $('#m_staff').value, date: dateV, start, name: $('#m_name').value, phone: $('#m_phone').value, email: $('#m_email').value, note: $('#m_note').value, internal: $('#m_internal').value };
      try {
        if (isNew) {
          payload.notify = $('#m_notify').checked;
          try { await api('/api/admin/appointments', { body: payload }); }
          catch (e) { if (e.code === 'clash' && confirm(e.message)) { payload.force = true; await api('/api/admin/appointments', { body: payload }); } else throw e; }
          toast('Termin angelegt');
        } else {
          payload.status = $('#m_status').value;
          await api('/api/admin/appointments/' + a.id, { method: 'PATCH', body: payload });
          toast('Gespeichert');
        }
        close(); go(currentView());
      } catch (e) { modalMsg(e.message); }
    }, extraBtns);
    if (a) $('#m_del').onclick = async () => { if (confirm('Diesen Termin endgültig löschen?')) { await api('/api/admin/appointments/' + a.id, { method: 'DELETE' }); toast('Gelöscht'); closeModal(); go(currentView()); } };
  }

  // ─── Leistungen ─────────────────────────────────────────────────────────────
  VIEWS.services = async v => {
    const [services, staff] = [await getServices(true), await getStaff()];
    v.innerHTML = `<div class="toolbar"><div class="grow"></div><button class="btn sm" id="addS">+ Leistung</button></div><div id="sList" class="rows"></div>`;
    const list = $('#sList');
    if (!services.length) list.innerHTML = '<p class="empty-state">Noch keine Leistungen. Legen Sie die erste an.</p>';
    for (const s of services) {
      const r = el('div', 'row');
      r.innerHTML = `<div class="main"><div class="nm">${esc(s.name)} ${s.active ? '' : '<span class="chip off">inaktiv</span>'}</div>
        <div class="sub">${s.dur} Min${s.buffer_min ? ' (+' + s.buffer_min + ' Puffer)' : ''}${s.price_cents ? ' · ' + euro(s.price_cents) : ''}${s.deposit_cents ? ' · Anzahlung ' + euro(s.deposit_cents) : ''}</div></div>`;
      const acts = el('div', 'acts', '<button class="iconbtn">✎</button><button class="iconbtn" title="Löschen">🗑</button>');
      acts.children[0].onclick = () => editService(s, staff);
      acts.children[1].onclick = async () => { if (confirm('Leistung „' + s.name + '“ löschen?')) { await api('/api/admin/services/' + s.id, { method: 'DELETE' }); toast('Gelöscht'); go('services'); } };
      r.appendChild(acts); list.appendChild(r);
    }
    $('#addS').onclick = () => editService(null, staff);
  };
  function editService(s, staff) {
    const isNew = !s;
    const body = `
      <div class="field"><label>Name</label><input id="s_name" value="${esc(s ? s.name : '')}"></div>
      <div class="mrow">
        <div class="field"><label>Dauer (Min)</label><input id="s_dur" type="number" min="5" step="5" value="${s ? s.dur : 30}"></div>
        <div class="field"><label>Puffer danach (Min)</label><input id="s_buffer" type="number" min="0" step="5" value="${s ? s.buffer_min : 0}"></div>
      </div>
      <div class="mrow">
        <div class="field"><label>Preis (€, optional)</label><input id="s_price" inputmode="decimal" value="${s ? toEuroInput(s.price_cents) : ''}"></div>
        <div class="field"><label>Anzahlung (€, optional)</label><input id="s_deposit" inputmode="decimal" value="${s ? toEuroInput(s.deposit_cents) : ''}"></div>
      </div>
      <div class="field"><label>Hinweis (optional)</label><input id="s_hint" value="${esc(s ? s.hint : '')}"></div>
      <div class="field"><label>Anbietende Mitarbeiter <span class="hint">(keiner markiert = alle)</span></label>
        <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:4px">${staff.map(st => `<label style="font-weight:500;display:flex;gap:6px;align-items:center"><input type="checkbox" class="s_staff" value="${st.id}" style="width:auto" ${s && s.staff && s.staff.includes(st.id) ? 'checked' : ''}>${esc(st.name)}</label>`).join('')}</div>
      </div>
      <label class="checkrow" style="font-weight:500"><input type="checkbox" id="s_active" ${!s || s.active ? 'checked' : ''}> aktiv (online buchbar)</label>`;
    openModal(isNew ? 'Leistung anlegen' : 'Leistung bearbeiten', body, async close => {
      const payload = {
        name: $('#s_name').value, dur: parseInt($('#s_dur').value) || 30, buffer_min: parseInt($('#s_buffer').value) || 0,
        price_cents: money($('#s_price').value), deposit_cents: money($('#s_deposit').value), hint: $('#s_hint').value,
        active: $('#s_active').checked, staff: [...document.querySelectorAll('.s_staff:checked')].map(c => c.value),
      };
      try { await api(isNew ? '/api/admin/services' : '/api/admin/services/' + s.id, { method: isNew ? 'POST' : 'PATCH', body: payload }); toast('Gespeichert'); close(); go('services'); }
      catch (e) { modalMsg(e.message); }
    });
  }

  // ─── Mitarbeiter ──────────────────────────────────────────────────────────
  VIEWS.staff = async v => {
    const staff = await getStaff(true);
    v.innerHTML = `<div class="toolbar"><div class="grow"></div><button class="btn sm" id="addSt">+ Mitarbeiter</button></div><div id="stList" class="rows"></div>`;
    const list = $('#stList');
    for (const s of staff) {
      const r = el('div', 'row');
      r.innerHTML = `<span class="dot-staff" style="background:${s.color};width:16px;height:16px"></span><div class="main"><div class="nm">${esc(s.name)} ${s.active ? '' : '<span class="chip off">inaktiv</span>'}</div></div>`;
      const acts = el('div', 'acts', '<button class="iconbtn">✎</button><button class="iconbtn">🗑</button>');
      acts.children[0].onclick = () => editStaff(s);
      acts.children[1].onclick = async () => { if (confirm('„' + s.name + '“ löschen?')) { try { await api('/api/admin/staff/' + s.id, { method: 'DELETE' }); toast('Gelöscht'); go('staff'); } catch (e) { toast(e.message, true); } } };
      r.appendChild(acts); list.appendChild(r);
    }
    $('#addSt').onclick = () => editStaff(null);
  };
  function editStaff(s) {
    const isNew = !s;
    const body = `
      <div class="field"><label>Name</label><input id="st_name" value="${esc(s ? s.name : '')}"></div>
      <div class="field"><label>Farbe im Kalender</label><input id="st_color" type="color" value="${s ? s.color : '#2563eb'}" style="height:44px;padding:4px"></div>
      <label class="checkrow" style="font-weight:500"><input type="checkbox" id="st_active" ${!s || s.active ? 'checked' : ''}> aktiv</label>`;
    openModal(isNew ? 'Mitarbeiter anlegen' : 'Mitarbeiter bearbeiten', body, async close => {
      const payload = { name: $('#st_name').value, color: $('#st_color').value, active: $('#st_active').checked };
      try { await api(isNew ? '/api/admin/staff' : '/api/admin/staff/' + s.id, { method: isNew ? 'POST' : 'PATCH', body: payload }); toast('Gespeichert'); close(); go('staff'); }
      catch (e) { modalMsg(e.message); }
    });
  }

  // ─── Sperrzeiten ──────────────────────────────────────────────────────────
  VIEWS.blocks = async v => {
    const [data, staff] = [await api('/api/admin/blocks'), await getStaff()];
    v.innerHTML = `<div class="toolbar"><div class="grow"></div><button class="btn sm" id="addB">+ Sperrzeit / Urlaub</button></div><div id="bList" class="rows"></div>`;
    const list = $('#bList');
    if (!data.blocks.length) list.innerHTML = '<p class="empty-state">Keine Sperrzeiten.</p>';
    for (const b of data.blocks) {
      const r = el('div', 'row');
      const span = b.date_from === b.date_to ? deDate(b.date_from) : deDate(b.date_from) + ' – ' + deDate(b.date_to);
      const time = b.start != null ? ' · ' + hhmm(b.start) + '–' + hhmm(b.stop) : ' · ganztägig';
      r.innerHTML = `<div class="main"><div class="nm">${span}${time}</div><div class="sub">${b.staff_id ? esc(staffName(staff, b.staff_id)) : 'ganzer Betrieb'}${b.reason ? ' · ' + esc(b.reason) : ''}</div></div>`;
      const acts = el('div', 'acts', '<button class="iconbtn">🗑</button>');
      acts.children[0].onclick = async () => { await api('/api/admin/blocks/' + b.id, { method: 'DELETE' }); toast('Entfernt'); go('blocks'); };
      r.appendChild(acts); list.appendChild(r);
    }
    $('#addB').onclick = () => {
      const body = `
        <div class="mrow"><div class="field"><label>Von</label><input id="b_from" type="date" value="${todayStr()}"></div><div class="field"><label>Bis</label><input id="b_to" type="date" value="${todayStr()}"></div></div>
        <label class="checkrow" style="font-weight:500"><input type="checkbox" id="b_allday" checked> ganztägig</label>
        <div class="mrow" id="b_times" style="display:none"><div class="field"><label>Von (Uhr)</label><input id="b_start" type="time" value="12:00"></div><div class="field"><label>Bis (Uhr)</label><input id="b_stop" type="time" value="13:00"></div></div>
        <div class="field"><label>Mitarbeiter</label><select id="b_staff"><option value="">ganzer Betrieb</option>${staff.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Grund (optional)</label><input id="b_reason" placeholder="Urlaub, Pause, Fortbildung …"></div>`;
      openModal('Sperrzeit anlegen', body, async close => {
        const allday = $('#b_allday').checked;
        const payload = { date_from: $('#b_from').value, date_to: $('#b_to').value, staff: $('#b_staff').value, reason: $('#b_reason').value };
        if (!allday) { payload.start = $('#b_start').value; payload.stop = $('#b_stop').value; }
        try { await api('/api/admin/blocks', { body: payload }); toast('Angelegt'); close(); go('blocks'); } catch (e) { modalMsg(e.message); }
      });
      $('#b_allday').onchange = e => $('#b_times').style.display = e.target.checked ? 'none' : 'grid';
    };
  };

  // ─── Einstellungen ────────────────────────────────────────────────────────
  VIEWS.settings = async v => {
    const data = await api('/api/admin/settings');
    const s = data.settings, t = data.tenant;
    const hoursHtml = TAGE.map((wd, d) => {
      const ranges = (s.hours[d] || []);
      return `<div class="hours-day" data-day="${d}"><div class="wd">${['So','Mo','Di','Mi','Do','Fr','Sa'][d]}</div><div class="ranges">${ranges.map(rng => rangeHtml(rng)).join('') || '<span class="muted" style="font-size:.85rem">geschlossen</span>'}</div><button class="btn ghost xs addRange" data-day="${d}">+ Zeit</button></div>`;
    }).join('');
    v.innerHTML = `
      <div class="panel-card"><h2 class="sec">Betrieb</h2>
        <div class="mrow"><div class="field"><label>Name</label><input id="p_name" value="${esc(t.name)}"></div><div class="field"><label>Telefon</label><input id="p_phone" value="${esc(t.phone)}"></div></div>
        <div class="mrow"><div class="field"><label>E-Mail</label><input id="p_email" value="${esc(t.email)}"></div><div class="field"><label>Adresse</label><input id="p_address" value="${esc(t.address)}"></div></div>
        <button class="btn sm" id="saveProfile">Betrieb speichern</button>
      </div>
      <div class="panel-card"><h2 class="sec">Öffnungszeiten</h2><div id="hours">${hoursHtml}</div></div>
      <div class="panel-card"><h2 class="sec">Buchung</h2>
        <div class="mrow">
          <div class="field"><label>Buchbar bis … Tage im Voraus</label><input id="o_days" type="number" min="1" max="180" value="${s.days_ahead}"></div>
          <div class="field"><label>Vorlauf (Stunden)</label><input id="o_notice" type="number" min="0" max="336" value="${s.min_notice_hours}"></div>
        </div>
        <div class="mrow">
          <div class="field"><label>Raster Startzeiten (Min)</label><select id="o_step">${[5,10,15,20,30,60].map(x => `<option ${s.step === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
          <div class="field"><label>Online-Absage bis … Std. vorher</label><input id="o_cancel" type="number" min="0" max="336" value="${s.cancel_hours}"></div>
        </div>
        <label class="checkrow" style="font-weight:500"><input type="checkbox" id="o_enabled" ${s.booking_enabled ? 'checked' : ''}> Online-Buchung aktiv</label>
        <label class="checkrow" style="font-weight:500"><input type="checkbox" id="o_email" ${s.require_email ? 'checked' : ''}> E-Mail beim Buchen Pflicht</label>
        <label class="checkrow" style="font-weight:500"><input type="checkbox" id="o_holidays" ${s.skip_holidays ? 'checked' : ''}> an gesetzlichen Feiertagen (NRW) geschlossen</label>
      </div>
      <div class="panel-card"><h2 class="sec">Erinnerungen & Erscheinungsbild</h2>
        <label class="checkrow" style="font-weight:500"><input type="checkbox" id="o_rem" ${s.reminder ? 'checked' : ''}> E-Mail-Erinnerung am Vortag</label>
        <label class="checkrow" style="font-weight:500"><input type="checkbox" id="o_remwa" ${s.reminder_wa ? 'checked' : ''} ${(t.plan === 'plus' || t.plan === 'pro') ? '' : 'disabled'}> WhatsApp/SMS-Erinnerung ${(t.plan === 'plus' || t.plan === 'pro') ? '' : '<span class="chip warn">ab Plus</span>'}</label>
        <div class="field" style="margin-top:12px"><label>Akzentfarbe</label><input id="o_color" type="color" value="${/^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : '#2563eb'}" style="height:44px;width:80px;padding:4px"></div>
        <div class="field"><label>Begrüßungstext (Buchungsseite)</label><input id="o_welcome" value="${esc(s.welcome)}" maxlength="400"></div>
        <div class="field"><label>Hinweis oben (z. B. Urlaub)</label><input id="o_notice2" value="${esc(s.notice)}" maxlength="400"></div>
      </div>
      <div class="toolbar"><button class="btn" id="saveSettings">Einstellungen speichern</button></div>
      <div class="panel-card"><h2 class="sec">Passwort ändern</h2>
        <div class="mrow"><div class="field"><label>Aktuelles Passwort</label><input id="pw_old" type="password"></div><div class="field"><label>Neues Passwort</label><input id="pw_new" type="password"></div></div>
        <button class="btn ghost sm" id="savePw">Passwort ändern</button>
      </div>`;

    // Öffnungszeiten-Editor
    $('#hours').addEventListener('click', e => {
      if (e.target.classList.contains('addRange')) { const d = e.target.dataset.day; const box = $('#hours').querySelector(`.hours-day[data-day="${d}"] .ranges`); if (box.querySelector('.muted')) box.innerHTML = ''; box.insertAdjacentHTML('beforeend', rangeHtml(['09:00', '18:00'])); }
      if (e.target.classList.contains('delRange')) { const box = e.target.closest('.ranges'); e.target.closest('.range').remove(); if (!box.children.length) box.innerHTML = '<span class="muted" style="font-size:.85rem">geschlossen</span>'; }
    });

    $('#saveProfile').onclick = async () => {
      try { const r = await api('/api/admin/profile', { method: 'PUT', body: { name: $('#p_name').value, phone: $('#p_phone').value, email: $('#p_email').value, address: $('#p_address').value } }); auth.tenant = { ...auth.tenant, ...r.tenant }; saveAuth(); $('#sideBiz').textContent = auth.tenant.name; toast('Betrieb gespeichert'); } catch (e) { toast(e.message, true); }
    };
    $('#saveSettings').onclick = async () => {
      const hours = {};
      $('#hours').querySelectorAll('.hours-day').forEach(day => {
        const d = day.dataset.day, arr = [];
        day.querySelectorAll('.range').forEach(rg => { const i = rg.querySelectorAll('input'); if (i[0].value && i[1].value) arr.push([i[0].value, i[1].value]); });
        if (arr.length) hours[d] = arr;
      });
      const payload = {
        hours, days_ahead: +$('#o_days').value, min_notice_hours: +$('#o_notice').value, step: +$('#o_step').value, cancel_hours: +$('#o_cancel').value,
        booking_enabled: $('#o_enabled').checked, require_email: $('#o_email').checked, skip_holidays: $('#o_holidays').checked,
        reminder: $('#o_rem').checked, reminder_wa: $('#o_remwa').checked, color: $('#o_color').value, welcome: $('#o_welcome').value, notice: $('#o_notice2').value,
      };
      try { await api('/api/admin/settings', { method: 'PUT', body: payload }); toast('Einstellungen gespeichert'); } catch (e) { toast(e.message, true); }
    };
    $('#savePw').onclick = async () => {
      try { await api('/api/admin/password', { method: 'POST', body: { old: $('#pw_old').value, new: $('#pw_new').value } }); toast('Passwort geändert'); $('#pw_old').value = $('#pw_new').value = ''; } catch (e) { toast(e.message, true); }
    };
  };
  function rangeHtml(rng) { return `<span class="range"><input type="time" value="${rng[0]}">–<input type="time" value="${rng[1]}"><button class="iconbtn delRange" type="button" style="width:26px;height:26px">×</button></span>`; }

  // ─── Team ──────────────────────────────────────────────────────────────────
  VIEWS.team = async v => {
    const data = await api('/api/admin/users');
    v.innerHTML = `<div class="toolbar"><div class="grow"></div><button class="btn sm" id="addU">+ Zugang</button></div>
      <table class="tbl"><thead><tr><th>Benutzer</th><th>Rolle</th><th>Status</th><th></th></tr></thead><tbody id="uBody"></tbody></table>`;
    const body = $('#uBody');
    data.users.forEach(u => {
      const tr = el('tr');
      tr.innerHTML = `<td><strong>${esc(u.username)}</strong><br><span class="muted">${esc(u.name)}</span></td><td>${u.role === 'admin' ? 'Inhaber' : 'Team'}</td><td>${u.active ? '<span class="chip ok">aktiv</span>' : '<span class="chip off">gesperrt</span>'}</td>`;
      const td = el('td');
      if (u.id !== auth.user.id) {
        const b = el('button', 'iconbtn', '✎'); b.onclick = () => editUser(u); td.appendChild(b);
        const d = el('button', 'iconbtn', '🗑'); d.style.marginLeft = '6px'; d.onclick = async () => { if (confirm('Zugang „' + u.username + '“ löschen?')) { try { await api('/api/admin/users/' + u.id, { method: 'DELETE' }); toast('Gelöscht'); go('team'); } catch (e) { toast(e.message, true); } } }; td.appendChild(d);
      } else td.innerHTML = '<span class="muted">(Sie)</span>';
      tr.appendChild(td); body.appendChild(tr);
    });
    $('#addU').onclick = () => {
      const b = `<div class="field"><label>Benutzername</label><input id="u_user"></div><div class="field"><label>Name</label><input id="u_name"></div><div class="field"><label>Passwort (mind. 10)</label><input id="u_pass" type="password"></div><div class="field"><label>Rolle</label><select id="u_role"><option value="team">Team</option><option value="admin">Inhaber</option></select></div>`;
      openModal('Zugang anlegen', b, async close => { try { await api('/api/admin/users', { body: { username: $('#u_user').value, name: $('#u_name').value, password: $('#u_pass').value, role: $('#u_role').value } }); toast('Angelegt'); close(); go('team'); } catch (e) { modalMsg(e.message); } });
    };
  };
  function editUser(u) {
    const b = `<p class="muted">${esc(u.username)}</p><div class="field"><label>Rolle</label><select id="u_role"><option value="team" ${u.role === 'team' ? 'selected' : ''}>Team</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Inhaber</option></select></div>
      <label class="checkrow" style="font-weight:500"><input type="checkbox" id="u_active" ${u.active ? 'checked' : ''}> aktiv</label>
      <div class="field" style="margin-top:12px"><label>Neues Passwort (optional)</label><input id="u_pass" type="password"></div>`;
    openModal('Zugang bearbeiten', b, async close => { const payload = { role: $('#u_role').value, active: $('#u_active').checked }; if ($('#u_pass').value) payload.password = $('#u_pass').value; try { await api('/api/admin/users/' + u.id, { method: 'PATCH', body: payload }); toast('Gespeichert'); close(); go('team'); } catch (e) { modalMsg(e.message); } });
  }

  // ─── Abo ─────────────────────────────────────────────────────────────────
  VIEWS.billing = async v => {
    const b = await api('/api/admin/billing');
    const names = { basis: 'Basis (19 €)', plus: 'Plus (29 €)', pro: 'Pro (49 €)' };
    const statusTxt = { trial: `Testphase – noch ${b.trial_days_left} Tag(e)`, active: 'Aktiv', past_due: 'Zahlung ausstehend', canceled: 'Kein aktives Abo' }[b.status] || b.status;
    v.innerHTML = `
      <div class="panel-card"><h2 class="sec">Ihr Abo</h2>
        <p>Paket: <strong>${names[b.plan] || b.plan}</strong></p>
        <p>Status: <strong>${statusTxt}</strong></p>
      </div>
      <div class="panel-card"><h2 class="sec">Paket wählen / wechseln</h2>
        ${b.configured ? '' : '<div class="msg info">Die Online-Bezahlung ist für diesen Mandanten noch nicht freigeschaltet. Bitte beim Anbieter melden – im Test läuft alles normal weiter.</div>'}
        <div class="prices" style="margin-top:8px">
          ${plan('basis', 'Basis', '19 €', ['Online-Buchung', 'Kalender & Team', 'E-Mail-Erinnerung', 'Keine Provision'], b)}
          ${plan('plus', 'Plus', '29 €', ['Alles aus Basis', 'WhatsApp/SMS-Erinnerung', 'No-Show-Anzahlung'], b)}
          ${plan('pro', 'Pro', '49 €', ['Alles aus Plus', 'KI-Telefonassistent'], b)}
        </div>
      </div>`;
    v.querySelectorAll('[data-plan]').forEach(btn => btn.onclick = async () => {
      if (!b.configured) { toast('Bezahlung noch nicht freigeschaltet', true); return; }
      btn.disabled = true;
      try { const r = await api('/api/admin/billing/checkout', { body: { plan: btn.dataset.plan } }); location.href = r.url; }
      catch (e) { toast(e.message, true); btn.disabled = false; }
    });
  };
  function plan(id, name, price, feats, b) {
    const cur = b.plan === id && (b.status === 'active');
    return `<div class="price ${id === 'plus' ? 'best' : ''}"><h3>${name}</h3><div class="amt">${price}<small>/Monat</small></div>
      <ul>${feats.map(f => `<li>${f}</li>`).join('')}</ul>
      <button class="btn ${id === 'plus' ? '' : 'ghost'}" data-plan="${id}" ${cur ? 'disabled' : ''}>${cur ? 'Aktuelles Paket' : 'Wählen'}</button></div>`;
  }

  // ─── Modal-Helfer ───────────────────────────────────────────────────────────
  let modalEl = null;
  function openModal(title, bodyHtml, onSave, extraBtns) {
    closeModal();
    modalEl = el('div', 'modal-scrim');
    modalEl.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><div class="mbody">${bodyHtml}</div><div id="modalMsg"></div><div class="modal-acts">${extraBtns || ''}<button class="btn ghost" id="mCancel">Abbrechen</button><button class="btn" id="mSave">Speichern</button></div></div>`;
    document.body.appendChild(modalEl);
    modalEl.querySelector('#mCancel').onclick = closeModal;
    modalEl.onclick = e => { if (e.target === modalEl) closeModal(); };
    modalEl.querySelector('#mSave').onclick = () => onSave(closeModal);
  }
  function modalMsg(m) { if (modalEl) modalEl.querySelector('#modalMsg').innerHTML = '<div class="msg err">' + esc(m) + '</div>'; }
  function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // ─── Utils ───────────────────────────────────────────────────────────────
  function todayStr() { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); const o = {}; p.forEach(x => o[x.type] = x.value); return `${o.year}-${o.month}-${o.day}`; }
  function addDays(d, n) { const t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * 86400000; return new Date(t).toISOString().slice(0, 10); }
  function currentView() { const on = document.querySelector('.menu button.on'); return on ? on.dataset.view : 'dash'; }

  // ─── Start ───────────────────────────────────────────────────────────────
  loadAuth();
  if (auth && auth.token) startApp().catch(() => showLogin());
  else showLogin();
})();
