// TerminPilot — Einbett-Widget für die eigene Website des Betriebs.
// Einbau (vom Betrieb auf seiner Seite):
//   Inline:  <div id="terminpilot"></div>
//            <script src="https://app.terminpilot.app/embed.js" data-betrieb="salon-mueller"></script>
//   Button:  <script src="https://app.terminpilot.app/embed.js" data-betrieb="salon-mueller" data-modus="button" data-text="Termin buchen"></script>
(function () {
  var s = document.currentScript;
  if (!s) return;
  var slug = s.getAttribute('data-betrieb') || s.getAttribute('data-slug');
  if (!slug) { console.warn('TerminPilot: data-betrieb fehlt'); return; }
  var origin = (s.src || '').replace(/\/embed\.js.*$/, '') || 'https://app.terminpilot.app';
  var mode = s.getAttribute('data-modus') || 'inline';
  var color = s.getAttribute('data-farbe') || '';
  var url = origin + '/buchen.html?b=' + encodeURIComponent(slug) + (color ? '&c=' + encodeURIComponent(color.replace('#', '')) : '');

  function iframe(extra) {
    var f = document.createElement('iframe');
    f.src = url;
    f.title = 'Termin buchen';
    f.loading = 'lazy';
    f.style.cssText = 'width:100%;border:0;background:#fff;' + (extra || '');
    f.setAttribute('allow', 'payment');
    return f;
  }

  if (mode === 'inline') {
    var host = document.getElementById('terminpilot') || (function () { var d = document.createElement('div'); s.parentNode.insertBefore(d, s); return d; })();
    var f = iframe('min-height:760px;border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,.05),0 8px 28px rgba(0,0,0,.07)');
    host.appendChild(f);
    // Höhe an Inhalt anpassen, wenn die Buchungsseite ihre Höhe meldet
    window.addEventListener('message', function (e) {
      if (e.origin === origin && e.data && e.data.tpHeight) f.style.minHeight = Math.max(560, e.data.tpHeight) + 'px';
    });
    return;
  }

  // Floating-Button + Modal
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = s.getAttribute('data-text') || 'Termin buchen';
  var accent = color || '#2563eb';
  btn.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483000;background:' + accent + ';color:#fff;border:0;border-radius:999px;padding:14px 22px;font:600 16px -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer';

  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483001;background:rgba(10,15,20,.55);display:none;align-items:center;justify-content:center;padding:16px';
  var box = document.createElement('div');
  box.style.cssText = 'position:relative;width:100%;max-width:760px;height:90vh;background:#fff;border-radius:16px;overflow:hidden';
  var close = document.createElement('button');
  close.innerHTML = '&times;';
  close.setAttribute('aria-label', 'Schließen');
  close.style.cssText = 'position:absolute;top:8px;right:12px;z-index:2;background:#fff;border:1px solid #e4e8ee;border-radius:50%;width:36px;height:36px;font-size:22px;line-height:1;cursor:pointer';
  var f2 = iframe('height:100%');
  box.appendChild(close); box.appendChild(f2); overlay.appendChild(box);

  function open() { overlay.style.display = 'flex'; document.body.style.overflow = 'hidden'; }
  function hide() { overlay.style.display = 'none'; document.body.style.overflow = ''; }
  btn.onclick = open; close.onclick = hide;
  overlay.onclick = function (e) { if (e.target === overlay) hide(); };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });

  document.body.appendChild(btn);
  document.body.appendChild(overlay);
})();
