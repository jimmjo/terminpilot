# TerminPilot – Einrichtung (Cloudflare, nur Dashboard-Klickpfad)

Universelle Terminbuchungs-Software als SaaS: **ein** Worker + **eine** D1-Datenbank bedienen beliebig viele Betriebe. Jeder Betrieb („Tenant") ist strikt per `tenant_id` getrennt, Kundendaten liegen verschlüsselt (Schlüssel pro Tenant aus `MASTER_KEY` abgeleitet).

```
terminpilot/
├── server/   → Cloudflare Worker + D1 (die API)
│   ├── server.js      die gesamte Logik
│   ├── schema.sql     Datenbank-Tabellen
│   └── wrangler.toml  Referenz der Bindings (Einrichtung geht per Dashboard)
└── web/      → Cloudflare Pages (Landing, Buchung, Verwaltung, Betreiber)
```

**Zwei Deployments:** 1) die API als Worker, 2) der `web/`-Ordner als Pages-Projekt.

---

## 0. MASTER_KEY erzeugen (einmal, im Terminal)

```
openssl rand -base64 32
```
Das Ergebnis (32 Byte, Base64) gut aufbewahren (Passwort-Manager). **Nie ändern, nie verlieren** – sonst sind alle Kundendaten unlesbar.

---

## 1. Datenbank anlegen (Cloudflare → Storage & Databases → D1)

1. **Create database** → Name `terminpilot` → Create.
2. Reiter **Console** → Inhalt von `server/schema.sql` einfügen → **Execute**. (Legt alle Tabellen an.)
3. Die **Database ID** merken (steht oben in der Übersicht).

## 2. Worker anlegen (Cloudflare → Workers & Pages → Create → Worker)

1. Name z. B. `terminpilot-api` → **Deploy** (Standard-Hello-World).
2. **Edit code** → den ganzen Inhalt von `server/server.js` einfügen → **Deploy**.
3. **Settings → Bindings → Add → D1 database**: Variable name `DB`, Datenbank `terminpilot` → Save.
4. **Settings → Trigger Events → Cron Triggers → Add**: `*/5 * * * *` → Save. (Erinnerungen + nächtliches Aufräumen.)
5. **Settings → Variables and Secrets**:
   - *Plaintext* `APP_ORIGINS` = `https://<deine-pages-domain>` (später eintragbar)
   - *Plaintext* `SIGNUP_ENABLED` = `1`
   - *Plaintext* `MAIL_FROM` = `termine@<deine-domain>`
   - *Secret* `MASTER_KEY` = der Wert aus Schritt 0
   - *Secret* `OPERATOR_SETUP_CODE` = ein selbst gewählter, langer Code (nur für die Ersteinrichtung deines Betreiber-Zugangs)
6. **Settings → Domains & Routes → Add → Custom domain**: z. B. `api.terminpilot.app` (oder die Worker-`*.workers.dev`-URL nutzen).

Test: `https://api.terminpilot.app/api/health` → `{"ok":true,...}`

## 3. Website hochladen (Cloudflare → Workers & Pages → Create → Pages → Upload)

1. Den **Inhalt** des Ordners `web/` hochladen (nicht den Ordner selbst), Projektname z. B. `terminpilot`.
2. Nach dem Deploy die Pages-URL (z. B. `terminpilot.pages.dev` oder eigene Domain) notieren.
3. **Wichtig:** In jeder Seite steht oben `window.TP_API` nicht fest – der Client nimmt standardmäßig `https://api.terminpilot.app`. Weicht deine API-Domain ab, lege in `web/` eine Datei `config.js` an mit `window.TP_API='https://DEINE-API-DOMAIN'` und binde sie vor `api.js` ein – oder passe die Domain an. (Einfachste Variante: API wirklich unter `api.<deine-domain>` betreiben.)
4. Im Worker `APP_ORIGINS` auf die echte Pages-Domain setzen.

## 4. Betreiber-Zugang anlegen (du)

`https://<pages>/betreiber/` öffnen → mit `OPERATOR_SETUP_CODE` + Wunsch-Benutzer/Passwort den Betreiber-Zugang anlegen. Danach siehst du alle Betriebe, Status und kannst Pakete/Testphasen setzen.

## 5. Ersten Betrieb testen

`https://<pages>/registrieren.html` → Betrieb anlegen → du landest direkt in der Verwaltung. Buchungsseite: `https://<pages>/buchen.html?b=<adresse>`.

---

## Optional: E-Mail (Brevo)

Konto bei Brevo, Domain authentifizieren (1-Klick über Cloudflare), Absender `termine@<domain>`. Dann im Worker *Secret* `BREVO_API_KEY` setzen. Ohne Key läuft alles ohne Mails (Erinnerung dann nur, wenn gesetzt; Buchung funktioniert immer).

## Optional: WhatsApp / SMS (Plan Plus/Pro)

Einen EU-Anbieter wählen, der eine einfache HTTP-API bietet (Empfänger + Text). Im Worker:
- *Secret* `WA_API_URL` = Endpunkt, der `{to, text}` als JSON annimmt
- *Secret* `WA_API_KEY` = Bearer-Token (falls nötig)

Der Worker ruft diesen Endpunkt für Erinnerungen auf (nur bei Betrieben im Paket Plus/Pro mit aktivierter WA-Erinnerung). So bleibt der Anbieter austauschbar.

## Optional: Abrechnung (Stripe)

1. In Stripe drei **wiederkehrende Preise** anlegen (Basis 19 €, Plus 29 €, Pro 49 €, jeweils monatlich).
2. Im Worker *Secrets* setzen: `STRIPE_SECRET`, `STRIPE_PRICE_BASIS`, `STRIPE_PRICE_PLUS`, `STRIPE_PRICE_PRO`.
3. Stripe → Webhooks → Endpoint `https://api.<domain>/api/stripe/webhook`, Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Signing-Secret als *Secret* `STRIPE_WEBHOOK_SECRET` setzen.

Ohne Stripe bleibt alles im Test-/Aktiv-Modus nutzbar; Pakete setzt du dann manuell in der Betreiber-Konsole.

---

## Datenschutz / Recht (vor echtem Start)

- `web/impressum.html`, `web/datenschutz.html`, `web/agb.html` mit echten Angaben füllen.
- Auftragsverarbeitungsvertrag (AVV) zwischen dir (Anbieter/Auftragsverarbeiter) und jedem Betrieb bereitstellen.
- Hetzner/Cloudflare-Serverstandort EU sicherstellen (D1 liegt in der Cloudflare-Region).
- **Praxen/Gesundheitsdaten** (Art. 9 DSGVO, § 203 StGB) sind ein eigenes, strengeres Thema – zuerst mit Friseuren/Werkstätten/Beratung starten.

## Was noch fehlt / bewusst v2

- **Anzahlung bei No-Show wirklich einziehen** (braucht Stripe-Checkout/Connect pro Betrieb) – Feld & Anzeige sind vorbereitet, der Einzug ist noch nicht verdrahtet.
- **KI-Telefon**: EU-Sprach-Anbieter anbinden, der über die öffentliche Buch-API in denselben Kalender schreibt (Paket Pro).
- **Eigene Subdomain pro Betrieb** (`salon.terminpilot.app`): Wildcard-DNS + Pages-Routing; Standard ist aktuell `?b=adresse`.
- PWA-Icons (`web/verwaltung/icon-192.png` / `icon-512.png` / `icon-maskable-512.png`).
