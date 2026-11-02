# Instantflat

Selbst gehostetes Tool für den Wohnungssuche-Workflow. Fredy liefert Inserate, Instantflat verwaltet sie.
Siehe `instantflat-prompt.md` (Auftrag) und `docs/FREDY_INGEST.md`.

## Lokal ohne Docker (Etappe 1)
```bash
cp .env.example .env   # APP_SECRET und INGEST_TOKEN setzen
npm install
npm run dev            # API :8080, UI :5173
npm test
```
Erster Aufruf der UI: Passwort festlegen. Test-Ingest:
```bash
curl -X POST localhost:8080/api/ingest -H "Authorization: Bearer $INGEST_TOKEN" -H "content-type: application/json" \
  -d '{"provider":"immoscout","listings":[{"id":"1","title":"Test","price":"900 €"}]}'
```

## Docker
`docker compose -f docker-compose.dev.yml up` (Entwicklung) bzw. `docker compose up -d --build` (Produktion).

## Entwürfe (Etappe 3)
- `LLM_PROVIDER=template` (Standard): Bausteintext aus Profil und Inserat, ohne KI.
- `LLM_PROVIDER=local`: Container `llm` (llama-server mit Ternary-Bonsai-8B, Q2_0, ~2,2 GB). Start: `docker compose --profile llm up -d --build`.
  Das Modell wird beim ersten Start vom Hugging Face (`prism-ml/Ternary-Bonsai-8B-gguf`) in `/DATA/AppData/instantflat/models` geladen und per SHA-256 geprüft.
  Schlägt das Modell fehl oder erfindet Zahlen, fällt die App automatisch auf das Template zurück.
- Telegram: `TELEGRAM_BOT_TOKEN` und `TELEGRAM_CHAT_ID` in `.env` setzen, sonst bleibt der Bot aus.

## Browser und Session-Überwachung (Etappe 4)
- Container `browser`: Chromium + noVNC + CDP, Profil im Volume. Nur über `/browser` der App (Login nötig) erreichbar, CDP nur im Docker-Netz.
- `SESSION_MONITOR=true` aktiviert die Prüfung (alle 30–60 Min pro Portal). Bei Statuswechsel gibt es eine Telegram-Meldung mit Link.
- Selektoren der echten Portale sind noch **nicht kalibriert** (`server/src/portals/defs.ts`); bis dahin zeigt der Monitor "Prüfung fehlgeschlagen" statt eines falschen "Angemeldet".
- Tests mit echtem Browser: `docker compose -f docker-compose.dev.yml up -d browser mock-portal`, dann `E2E_BROWSER=1 npm test`.
  Das Mock-Portal lässt sich per Aufruf steuern: `localhost:4000/__expire`, `/__captcha`, `/__clear`, `/__login`.

## Senden und Queue (Etappe 5)
- Freigeben (UI, Telegram oder Automodus) legt das Inserat in die Outbox (höchstens einmal pro Inserat).
- Der Worker sendet nur bei Portalstatus `ok`, tagsüber (nicht 22–7 Uhr Berlin), unter dem Tageslimit **pro Portal** (Standard 7) und mit 2–8 Minuten Pause pro Portal.
- `DRY_RUN=true` (Standard): Formular wird ausgefüllt und fotografiert, nie abgeschickt. Probelauf-Einträge werden nach `DRY_RUN=false` nachgeholt.
- Unklarer Ausgang (Absturz oder keine Bestätigung nach dem Klick) → Status "Unklar", nie automatisch wiederholen. Auflösen im Verlauf.
- Der Worker läuft nur mit `SESSION_MONITOR=true`. Echte Portale senden erst, wenn ihre Selektoren kalibriert sind (`server/src/portals/defs.ts`).

## Kalibrierung der Portale (Selektoren als Konfiguration)
1. `portals.example.json` nach `DATA_DIR/portals.json` kopieren (oder Pfad in `PORTALS_CONFIG`) und pro Portal `selectors` und `send` eintragen. Ein Fehler in der Datei verhindert den Start mit klarer Meldung.
2. Im Server-Browser (`/browser`) beim Portal anmelden und die passende Seite öffnen.
3. `POST /api/portals/<id>/probe` (mit optionaler `url`) zeigt, wie oft jeder Selektor auf der Seite vorkommt. `loggedIn` muss ≥ 1 sein, wenn du angemeldet bist, `loggedOut` 0 usw. Danach "Jetzt prüfen" in den Einstellungen.
4. Erst wenn die Prüfung `Angemeldet` zeigt und der Dry-Run das Formular sauber ausfüllt, `DRY_RUN=false` setzen.

## Umkreis (Radius)
- In "Suchen" einen Mittelpunkt (Adresse) und einen Radius setzen. Der Mittelpunkt wird beim Speichern in Koordinaten umgerechnet.
- Neue Inserate werden über ihre Adresse verortet (OpenStreetMap Nominatim, höchstens 1 Anfrage pro Sekunde, Ergebnisse werden zwischengespeichert). **Dabei werden nur die Adresstexte der öffentlichen Inserate an Nominatim übertragen.**
- Außerhalb des Radius: verworfen mit Grund ("7,3 km > 5 km"). Nur Stadtteil bekannt: "Ort ungefähr", zählt als bekannt. Nur Stadt oder keine Adresse: **bleibt zur manuellen Prüfung liegen und wird im Automodus nie automatisch gesendet.**
- Fällt der Geocoder aus, gilt dasselbe. Eigene Instanz statt der öffentlichen: `nominatimGeocoder({ baseUrl })` in `server/src/geo.ts`.
- Der Worker prüft die Queue alle 10 Sekunden. Fredy-Intervall (z. B. 3 Minuten) stellst du in Fredy ein.
