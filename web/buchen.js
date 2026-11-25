// TerminPilot — Buchungsablauf
(function () {
  const { api, tenantSlug, euro, hhmm, deDate, esc } = window.TP;
  const slug = tenantSlug();
  const $ = s => document.querySelector(s);
  const state = { cfg: null, service: null, staff: 'any', date: null, start: null, slotsByDate: {} };

  if (!slug) { document.body.innerHTML = '<div class="wrap" style="padding:60px 20px"><h1>Kein Betrieb angegeben</h1><p>Diese Buchungsseite braucht eine Betriebs-Adresse (?b=…).</p></div>'; return; }

  function show(step) {
    document.querySelectorAll('.step').forEach(el => el.hidden = el.dataset.step !== step);
    const order = ['service', 'staff', 'time', 'data', 'done'];
    const idx = order.indexOf(step);
    document.querySelectorAll('#steps li').forEach((li, i) => {
      li.classList.toggle('on', i === idx);
      li.classList.toggle('done', i < idx);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    postHeight();
  }
  function postHeight() {
    if (window.parent === window) return;
    try { window.parent.postMessage({ tpHeight: document.body.scrollHeight + 40 }, '*'); } catch (e) {}
  }
  window.addEventListener('load', postHeight);
  window.addEventListener('resize', postHeight);

  function applyColor(c) {
    if (!/^#[0-9a-fA-F]{6}$/.test(c || '')) return;
    document.documentElement.style.setProperty('--accent', c);
    // dunklere Variante grob ableiten
    const n = parseInt(c.slice(1), 16);
    const d = (v, f) => Math.max(0, Math.round(((n >> f) & 255) * 0.82));
    document.documentElement.style.setProperty('--accent-dark', `rgb(${d(0,16)},${d(0,8)},${d(0,0)})`);
  }

  async function init() {
    try {
      const cfg = await api('/api/public/config?b=' + encodeURIComponent(slug));
      state.cfg = cfg;
      applyColor(cfg.color);
      document.title = 'Termin buchen – ' + cfg.name;
      $('#bizName').textContent = cfg.name;
      $('#footName').textContent = cfg.name;
      $('#bizMeta').textContent = [cfg.address, cfg.phone].filter(Boolean).join(' · ');
      if (cfg.welcome) { $('#notice').hidden = false; $('#notice').textContent = cfg.welcome; }
      if (cfg.notice) { $('#notice').hidden = false; $('#notice').innerHTML = (cfg.welcome ? esc(cfg.welcome) + '<br>' : '') + '<strong>' + esc(cfg.notice) + '</strong>'; }
      $('#emailHint').textContent = cfg.require_email ? '(Pflicht)' : (cfg.mail ? '(für Bestätigung & Erinnerung)' : '(optional)');
      if (cfg.require_email) $('#email').required = true;
      if (!cfg.booking_enabled) {
        $('#services').innerHTML = '<p class="empty">Die Online-Buchung ist zurzeit geschlossen.' + (cfg.phone ? ' Bitte rufen Sie an: ' + esc(cfg.phone) : '') + '</p>';
        document.querySelectorAll('.steps, .step[data-step="service"] h2').forEach(e => e.style.display = 'none');
        return;
      }
      renderServices();
    } catch (e) {
      document.querySelector('.bk-main').innerHTML = '<div class="step"><h2>Nicht erreichbar</h2><p>' + esc(e.message) + '</p></div>';
    }
  }

  function renderServices() {
    const el = $('#services');
    if (!state.cfg.services.length) { el.innerHTML = '<p class="empty">Zurzeit sind keine Leistungen buchbar.</p>'; return; }
    el.innerHTML = '';
    for (const s of state.cfg.services) {
      const b = document.createElement('button');
      b.innerHTML = `<span><span class="t">${esc(s.name)}</span><br><span class="d">${s.dur} Min${s.hint ? ' · ' + esc(s.hint) : ''}</span></span>` +
        (s.price_cents > 0 ? `<span class="price">${euro(s.price_cents)}</span>` : '');
      b.onclick = () => chooseService(s);
      el.appendChild(b);
    }
  }

  function chooseService(s) {
    state.service = s;
    const staff = state.cfg.staff || [];
    if (staff.length <= 1) { state.staff = 'any'; gotoTime(); return; }
    renderStaff();
    show('staff');
  }

  function renderStaff() {
    const el = $('#staff');
    el.innerHTML = '';
    const any = document.createElement('button');
    any.innerHTML = '<span class="t">Egal / nächster frei</span>';
    any.onclick = () => { state.staff = 'any'; gotoTime(); };
    el.appendChild(any);
    for (const m of state.cfg.staff) {
      const b = document.createElement('button');
      b.innerHTML = `<span class="t">${esc(m.name)}</span>`;
      b.onclick = () => { state.staff = m.id; gotoTime(); };
      el.appendChild(b);
    }
  }

  async function gotoTime() {
    $('#timeSummary').textContent = state.service.name + (state.staff !== 'any' ? ' · ' + (state.cfg.staff.find(s => s.id === state.staff) || {}).name : '');
    show('time');
    $('#days').innerHTML = '<p class="empty">Lade freie Zeiten …</p>';
    $('#slots').innerHTML = '';
    try {
      const r = await api(`/api/public/slots?b=${encodeURIComponent(slug)}&service=${encodeURIComponent(state.service.id)}&staff=${encodeURIComponent(state.staff)}`);
      const open = r.dates.filter(d => !d.closed && d.slots.length);
      state.slotsByDate = {};
      open.forEach(d => state.slotsByDate[d.date] = d.slots);
      if (!open.length) { $('#days').innerHTML = '<p class="empty">In den nächsten Tagen ist leider nichts frei.' + (state.cfg.phone ? ' Bitte rufen Sie an: ' + esc(state.cfg.phone) : '') + '</p>'; return; }
      renderDays(open);
      chooseDate(open[0].date);
    } catch (e) { $('#days').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; }
  }

  function renderDays(open) {
    const el = $('#days');
    el.innerHTML = '';
    for (const d of open) {
      const b = document.createElement('div');
      b.className = 'day';
      b.dataset.date = d.date;
      const wd = deDate(d.date).split(',')[0];
      b.innerHTML = `<div class="wd">${wd}</div><div class="dd">${d.date.slice(8, 10)}.</div><div class="wd">${d.date.slice(5, 7)}.</div>`;
      b.onclick = () => chooseDate(d.date);
      el.appendChild(b);
    }
  }

  function chooseDate(date) {
    state.date = date;
    document.querySelectorAll('.day').forEach(d => d.classList.toggle('on', d.dataset.date === date));
    const slots = state.slotsByDate[date] || [];
    const el = $('#slots');
    if (!slots.length) { el.innerHTML = '<p class="empty">Kein freier Termin an diesem Tag.</p>'; return; }
    el.innerHTML = `<p style="font-weight:650;margin:4px 0 12px">${deDate(date, true)}</p><div class="slots"></div>`;
    const g = el.querySelector('.slots');
    for (const s of slots) {
      const b = document.createElement('button');
      b.textContent = hhmm(s);
      b.onclick = () => chooseSlot(date, s);
      g.appendChild(b);
    }
  }

  function chooseSlot(date, start) {
    state.date = date; state.start = start;
    const end = start + state.service.dur;
    $('#dataSummary').innerHTML = `<strong>${esc(state.service.name)}</strong> · ${deDate(date, true)} · ${hhmm(start)}–${hhmm(end)} Uhr` +
      (state.staff !== 'any' ? ' · ' + esc((state.cfg.staff.find(s => s.id === state.staff) || {}).name) : '');
    show('data');
  }

  // Buchen absenden
  $('#form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#submit'); const msg = $('#formMsg');
    msg.innerHTML = '';
    if (!$('#consent').checked) { msg.innerHTML = '<div class="msg err">Bitte die Einwilligung bestätigen.</div>'; return; }
    btn.disabled = true; btn.textContent = 'Wird gebucht …';
    try {
      const r = await api('/api/public/book?b=' + encodeURIComponent(slug), {
        body: {
          service: state.service.id, staff: state.staff, date: state.date, start: state.start,
          name: $('#name').value, phone: $('#phone').value, email: $('#email').value, note: $('#note').value,
          consent: true, website: $('#website').value,
        },
      });
      showDone(r);
    } catch (err) {
      msg.innerHTML = '<div class="msg err">' + esc(err.message) + '</div>';
      if (err.code === 'slot_taken') { btn.textContent = 'Andere Zeit wählen'; btn.disabled = false; btn.onclick = () => gotoTime(); return; }
      btn.disabled = false; btn.textContent = 'Termin verbindlich buchen';
    }
  });

  function showDone(r) {
    const dep = r.deposit_cents > 0 ? `<p class="muted">Für diesen Termin ist eine Anzahlung von ${euro(r.deposit_cents)} vorgesehen – der Betrieb meldet sich dazu.</p>` : '';
    $('#doneDetails').innerHTML =
      `<div class="done-box">
        <div>${esc(r.service)}</div>
        <div style="font-weight:700;font-size:1.1rem">${deDate(r.date, true)} · ${hhmm(r.start)} Uhr</div>
        <div style="margin-top:12px">Buchungscode</div>
        <div class="code">${esc(r.code)}</div>
      </div>` +
      (r.mail ? '<p class="muted">Eine Bestätigung wurde per E-Mail versendet.</p>' : '') + dep;
    show('done');
  }

  // Zurück-Buttons
  document.querySelectorAll('.back').forEach(b => b.onclick = () => show(b.dataset.back));

  // Termin verwalten
  $('#manageForm').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#manageMsg'), res = $('#manageResult');
    msg.innerHTML = ''; res.innerHTML = '';
    try {
      const r = await api('/api/public/lookup?b=' + encodeURIComponent(slug), { body: { code: $('#mCode').value, phone: $('#mPhone').value } });
      const statusTxt = { angefragt: 'angefragt', bestaetigt: 'bestätigt', abgesagt: 'abgesagt', erledigt: 'erledigt', nicht_erschienen: 'nicht erschienen' }[r.status] || r.status;
      res.innerHTML = `<div class="result-box">
        <div><strong>${esc(r.service)}</strong></div>
        <div>${deDate(r.date, true)} · ${hhmm(r.start)} Uhr</div>
        <div class="muted">Status: ${statusTxt}</div>
        ${r.can_cancel ? '<button class="btn ghost" id="cancelBtn" style="margin-top:12px">Termin absagen</button>' : '<p class="muted" style="margin-top:12px">Online-Absage nicht mehr möglich.</p>'}
      </div>`;
      const cb = document.getElementById('cancelBtn');
      if (cb) cb.onclick = async () => {
        if (!confirm('Termin wirklich absagen?')) return;
        cb.disabled = true;
        try {
          await api('/api/public/cancel?b=' + encodeURIComponent(slug), { body: { code: $('#mCode').value, phone: $('#mPhone').value } });
          res.innerHTML = '<div class="msg ok">Ihr Termin wurde abgesagt.</div>';
        } catch (err) { cb.disabled = false; res.innerHTML += '<div class="msg err">' + esc(err.message) + '</div>'; }
      };
    } catch (err) { msg.innerHTML = '<div class="msg err">' + esc(err.message) + '</div>'; }
  });

  init();
})();
