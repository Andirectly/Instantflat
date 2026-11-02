# Deployment auf ZimaOS

Ziel: Compose-Stack aus `fredy`, `instantflat` und `browser` (optional `llm`). Alle Daten unter `/DATA/AppData/instantflat/`.

## 1. Voraussetzungen
- ZimaOS mit Docker und Compose (App "Terminal" oder SSH).
- 8 GB RAM sind knapp. Richtwerte (nicht gemessen, im Betrieb prüfen): Fredy mit eigenem Chromium ~0,6–1 GB, `browser` bis 1,5 GB (Limit gesetzt), `instantflat` ~0,2 GB, `llm` bis 4 GB (Limit gesetzt). **Mit `llm` wird es eng**, dann Fredy-Intervall nicht zu kurz wählen und `LLM_PROVIDER=template` als Rückfall behalten.

## 2. Dateien auf den Server
Entweder das Repo klonen und direkt dort bauen (einfachster Weg):
```bash
git clone <dein-repo> /DATA/AppData/instantflat/app && cd /DATA/AppData/instantflat/app
```
oder Images per Multi-Arch-Build in eine Registry schieben (siehe Abschnitt 7).

## 3. Konfiguration
```bash
cp .env.example .env
```
Pflichtwerte in `.env`:
- `APP_SECRET` (mind. 32 Zeichen): `openssl rand -hex 32`
- `INGEST_TOKEN` (mind. 16 Zeichen): `openssl rand -hex 24`
- `PUBLIC_URL`: Adresse, unter der du die App erreichst, z. B. `http://zimaos.local:8080`
- `DRY_RUN=true` **bleibt so, bis die Kalibrierung geprüft ist.**
- `SESSION_MONITOR=true`, sobald der Browser-Container läuft.
- Optional: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `LLM_PROVIDER=local`.

Portal-Selektoren bereitstellen:
```bash
mkdir -p /DATA/AppData/instantflat/data
cp config/portals.json /DATA/AppData/instantflat/data/portals.json
```

## 4. Erststart
```bash
docker compose up -d --build            # fredy, instantflat, browser
docker compose --profile llm up -d --build   # zusätzlich das lokale Modell (optional)
docker compose ps
```
Die UI ist unter `PUBLIC_URL` erreichbar. Beim ersten Aufruf das Passwort festlegen.
Nur Port 8080 ist veröffentlicht. Fredy-UI (9998) und CDP (9223) bleiben im Docker-Netz.

## 5. Fredy einrichten (einmalig)
Die Fredy-UI ist nicht veröffentlicht. Zugriff per SSH-Tunnel:
```bash
ssh -L 9998:localhost:9998 <user>@<zimaos>   # nur wenn der Port temporär freigegeben ist
```
oder in `docker-compose.yml` bei `fredy` vorübergehend `ports: ["9998:9998"]` ergänzen und danach wieder entfernen.
- **Admin-Passwort sofort ändern** (Standard `admin`/`admin`).
- Pro Portal einen Job mit deinem Such-Link anlegen. Intervall z. B. 3 Minuten.
- Benachrichtigung: Adapter **HTTP**, Endpoint `http://instantflat:8080/api/ingest`, Auth-Token = `INGEST_TOKEN`.
- Mit "Testen" prüfen: In Instantflat erscheint ein Test-Inserat.

## 6. Portale anmelden (Session einrichten)
1. In Instantflat: Einstellungen → "Im Server-Browser anmelden". Das öffnet den Browser des Servers (`/browser`).
2. Pro Portal selbst anmelden (Captcha oder Code selbst lösen). Instantflat speichert keine Passwörter, nur das Profil im Volume `/DATA/AppData/instantflat/browser-profile`.
3. Einstellungen → "Jetzt prüfen": Status muss "Angemeldet" zeigen.
4. Erst danach, nach einigen Tagen im Dry-Run (Verlauf mit Screenshots prüfen), `DRY_RUN=false` setzen und `docker compose up -d` ausführen.
Bei Layoutänderungen eines Portals: `docs/PORTALS.md` (neu kalibrieren).

## 7. Multi-Arch-Build (amd64 + arm64)
```bash
docker buildx create --use --name if-builder
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/instantflat:latest --push .
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/instantflat-browser:latest --push browser
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/instantflat-llm:latest --push llm
```
Im Compose dann `build:` durch `image:` ersetzen. Der `llm`-Build kompiliert llama.cpp und dauert pro Architektur lange.
Hinweis: Das ist nur aus der Anleitung abgeleitet. Gebaut und gestartet wurde bisher nur für die Architektur des Entwicklungs-PCs (amd64).

## 8. Backup
Alles Wichtige liegt in `/DATA/AppData/instantflat/`: `data/` (SQLite, Screenshots, `portals.json`), `browser-profile/` (Logins), `fredy/`, `models/` (neu ladbar).
Für ein konsistentes DB-Backup die App kurz stoppen oder `sqlite3 instantflat.db ".backup backup.db"` nutzen.

## 9. Update
```bash
git pull && docker compose up -d --build
```
Datenbank-Migrationen laufen beim Start automatisch. Fredy ist auf eine feste Version gepinnt (`docker-compose.yml`), bewusst anheben und danach den Ingest-Test (Abschnitt 5) wiederholen.

## 10. Fehlersuche
- UI weiß/leer: Läuft `docker compose ps`? Logs: `docker compose logs instantflat`.
- Portal zeigt "Prüfung fehlgeschlagen": `portals.json` vorhanden? Selektoren neu prüfen (`POST /api/portals/<id>/probe`).
- Kein Versand trotz Freigabe: Portalstatus "Angemeldet"? Nachtruhe 22–7 Uhr? Tageslimit pro Portal? Verlauf zeigt Gründe.
- Eintrag "Unklar" im Verlauf: Prüfen, ob die Nachricht beim Portal ankam, dann dort "Wurde gesendet" oder "Nicht gesendet" wählen.
- Portal sperrt die IP: nicht umgehen, Intervalle verlängern, später erneut versuchen.
