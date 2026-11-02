# Instantflat – Bauauftrag für Claude Code

Du übernimmst die Rolle des Lead Software Architects für die Entwicklung von **Instantflat**, einer selbst gehosteten Web-App zur Optimierung des Workflows bei der Wohnungssuche in Köln. Das System wird als Docker-Compose-Stack auf einem Homeserver (ZimaOS) betrieben. Die Entwicklung und Validierung erfolgt initial in einer Windows-Umgebung mit Docker Desktop (WSL2).

Arbeite modular in Etappen. Präsentiere vor jeder Phase deinen technischen Implementierungsplan und warte auf meine Freigabe.

---

## 1. Funktionale Anforderungen

1. **Daten-Ingestion:** Automatisierte Erfassung relevanter Mietinserate von ImmoScout24, Kleinanzeigen und Immowelt.
2. **Content-Generierung:** KI-gestützte Erstellung personalisierter Anfragen in deutscher Sprache, basierend auf den spezifischen Attributen des jeweiligen Exposés.
3. **Workflow-Management:** Implementierung eines Freigabe-Prozesses via Web-UI oder Telegram (Review-Modus) sowie einer Option zur automatisierten Übermittlung innerhalb definierter Parameter.
4. **Schnittstellen-Interaktion:** Übermittlung der Nachrichten über die bestehende Session des Nutzers mittels programmatischer Browser-Steuerung (CDP).
5. **Session-Monitoring:** Kontinuierliche Validierung des Authentifizierungsstatus der Portale. Bei Statusänderungen (z. B. Session-Timeout oder erforderliche Interaktion) erfolgt eine sofortige Benachrichtigung via Telegram.

Das Tool ist für die exklusive Nutzung durch einen einzelnen User konzipiert.

---

## 2. Systemarchitektur

Ein Compose-Stack bestehend aus drei dedizierten Services:

| Service | Spezifikation |
|---|---|
| `fredy` | Ingestion-Engine. Offizielles Image `ghcr.io/orangecoding/fredy` (gepinnte Version). Verantwortlich für die Portal-Durchsuchung und Deduplizierung. Interne Web-UI auf Port 9998. |
| `instantflat` | Core-Applikation: Backend, Management-UI, KI-Logik, Queue-System, Telegram-Schnittstelle, Session-Validierung. |
| `browser` | Headless Chromium mit noVNC-Interface und CDP-Zugriff. Hostet das persistente User-Profil in einem Volume. Die Steuerung erfolgt über das Chrome DevTools Protocol (CDP). |

**Datenfluss Fredy $\rightarrow$ Instantflat:** Implementierung eines effizienten Ingest-Mechanismus. Bevorzugt über einen Webhook (z. B. Fredys Apprise-Adapter via `json://`-URL auf `http://instantflat:8080/api/ingest`). Alternativ: Read-only Zugriff auf die SQLite-Datenbank von Fredy. Fredy wird als unveränderliches Image genutzt, um Updates zu gewährleisten.

**Lizenz-Compliance:** Integration eines Credits für Fredy und den Autor unter „Einstellungen $\rightarrow$ Über“ (Apache-2.0 / Commons Clause).

**Browser-Spezifikation:** Aufbau eines Chromium-Containers mit Debian-slim, Xvfb, x11vnc und noVNC/websockify. Konfiguration: `--remote-debugging-port=9222 --user-data-dir=/profile`. Der CDP-Port ist ausschließlich innerhalb des Docker-Netzwerks erreichbar. Die noVNC-Oberfläche wird über einen Reverse-Proxy in Instantflat unter `/browser` eingebettet. `shm_size` $\ge$ 1 GB.

### Tech-Stack (Vorschlag)

- **Runtime:** Node.js 22 LTS, TypeScript
- **Backend:** Fastify
- **Persistence:** SQLite (better-sqlite3) mit versionierten Migrationen
- **Frontend:** React + Vite (ausgeliefert vom Backend-Container)
- **Browser-Orchestrierung:** Playwright `connectOverCDP`
- **Messaging:** grammY (Long Polling)
- **LLM-Integration:** Anthropic API (Claude), konfigurierbar via `.env`
- **Testing:** Vitest, Playwright (E2E)

---

## 3. Implementierungsregeln

### Queue & Transmission
- **State-Machine:** `gefunden $\rightarrow$ gefiltert | verworfen $\rightarrow$ entwurf $\rightarrow$ freigegeben $\rightarrow$ gesendet $\rightarrow$ Antwort-Management`.
- **Idempotenz:** Absicherung gegen Mehrfachversand pro Inserat und Portal.
- **Interaktions-Intervalle:** Implementierung variabler Pausen (Standard 2–8 Min), Tageslimits und einer definierten Nachtruhe (22–7 Uhr).
- **Resilienz:** Nachrichten verbleiben bei Session-Unterbrechungen in der Queue und werden nach erfolgreicher Re-Authentifizierung chronologisch versendet.
- **Audit-Log:** Speicherung von Screenshots und Ergebnis-Metadaten nach jedem Sendeversuch.
- **Sicherheitsmodus:** Standardmäßig `DRY_RUN=true`. In diesem Modus werden alle Felder befüllt, aber die finale Übermittlung unterbleibt.

### Interface-Module (pro Portal)
- Einheitliches Interface: `checkSession()`, `send(listing, message)`, `detectState()` $\rightarrow$ `ok | session_expired | interaction_required | error`.
- Priorisierung: ImmoScout24 $\rightarrow$ Kleinanzeigen $\rightarrow$ Immowelt.
- **Interaktions-Logik:** Simulation natürlicher Eingabemuster (variable Schreibgeschwindigkeit, Pausen).
- Zentralisierte Selektoren-Verwaltung zur schnellen Anpassung an DOM-Änderungen.

### Session-Validierung
- Zyklische Prüfung des Login-Status (alle 30–60 Min mit Randomisierung).
- Differenzierung zwischen Logout und erforderlichen Interaktionen (z. B. Validierungscodes).
- Benachrichtigung via Telegram mit Direktlink zum integrierten Login-Fenster.
- Instantflat speichert keine Credentials, sondern nutzt ausschließlich das persistente Browser-Profil.

### KI-Generierung
- Kontext: User-Profil (Biografie, Termine, Haustiere etc.) + extrahierte Exposé-Daten.
- Stil: Deutsch, formell ("Sie"), personalisierte Anrede.
- Fokus: Bezugnahme auf 1–2 spezifische Details der Immobilie, Länge ca. 900 Zeichen.
- Verbot von Halluzinationen: Nur Fakten aus dem User-Profil verwenden.

### Telegram-Integration
- **Interaktive Karten:** Foto, Eckdaten, Link, Entwurf + Inline-Buttons (**Senden · Verwerfen · Bearbeiten**).
- Status-Updates: Login-Probleme, Antworten von Vermietern, tägliche Zusammenfassung.
- Zugriffsschutz: Reaktion nur auf eine spezifische Chat-ID.
- Nutzung einer konfigurierbaren `PUBLIC_URL` für App-Links.

---

## 4. Design-Spezifikationen

Umsetzung basierend auf den Mockups in `design/` (`Main.dc.html`, `Review.dc.html`, `Settings.dc.html`, `Mobile.dc.html`). Visuelle Referenz: Mac-Cleaner Burrow.

- **Farbwelt:** Hintergrund `#050508`, Punktraster (16px). Glow-Palette: Magenta, Violett, Blau, Ember, Sage, Lime, Graphit. Akzent: `#D6F559`.
- **Komponenten:** Karten-Radius 30px. "Rim"- und "Core"-Varianten. LED-Punktraster für numerische Anzeigen.
- **Layout:** Seitenleiste 210px, aktive Zustände als weiße Pillen. Logo oben links ohne Hintergrund.
- **UX:** Apple-Prinzipien (sofortiges Feedback, klare Hauptaktion pro Screen). Responsives Design mittels Container Queries. Einhaltung von Accessibility-Standards (Kontrast $\ge$ 4.5:1, Touch-Ziele $\ge$ 44px).

---

## 5. Sicherheit & Datenschutz

- Web-App Login für einen Einzelnutzer (Passwort-Hash, Session-Cookie, Rate-Limiting).
- Secret-Management via `.env`: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `APP_SECRET`, `PUBLIC_URL`, `DRY_RUN`.
- Netzwerkkonfiguration: Nur Instantflat-Port öffentlich. Fredy-UI und CDP-Port ausschließlich im internen Docker-Netz.

---

## 6. Testing & Qualitätssicherung (WSL2)

- **Umgebung:** Docker Desktop mit WSL2, `.gitattributes` für LF-Endings.
- **Infrastruktur:** `docker-compose.dev.yml` (Hot Reload) und `docker-compose.yml` (Produktion).
- **Mock-Umgebung:** Entwicklung eines Test-Services mit simulierten Kontaktformularen und Login-Seiten zur Validierung der Absender-Logik ohne Live-Zugriff.
- **Test-Suiten:** 
  - Ingestion-Tests (Fredy-Payloads).
  - KI-Generierung (Edge-Cases, API-Timeouts).
  - Queue-Logik (Limits, Pausen, Idempotenz).
  - Session-Recovery (Logout $\rightarrow$ Login $\rightarrow$ Versand).
  - UI-Tests via Playwright-Screenshots für verschiedene Viewports.

---

## 7. Deployment (ZimaOS)

- Multi-Arch Build (`amd64` & `arm64`).
- Deployment via private Registry oder direktes Git-Build auf dem Server.
- Volume-Mappings unter `/DATA/AppData/instantflat/` für DB, Browser-Profil und Logs.
- Erstellung einer `DEPLOY.md` mit Anweisungen zu `.env`, Erststart und Session-Einrichtung.

---

## 8. Implementierungs-Etappen

1. **Grundgerüst:** Repo-Setup, Compose-Konfiguration, Backend-Basis, Login-UI, Fredy-Ingest-Validierung.
2. **Datenfluss:** Ingestion, Filterung, Deduplizierung, Implementierung der Übersicht und Freigabe-Liste.
3. **Intelligence:** User-Profil, KI-Entwurf-Logik, Telegram-Interface mit Interaktions-Buttons.
4. **Browser-Infrastruktur:** Browser-Container, noVNC-Integration, Session-Monitoring, Mock-Portale.
5. **Schnittstellen-Implementierung (ImmoScout24):** Absender-Modul im Dry-Run, Screenshot-Logik, Queue-Management.
6. **Erweiterung:** Integration weiterer Portale (Kleinanzeigen, Immowelt).
7. **Optimierung:** Automodus, Verlauf, responsive UI, finaler Testkatalog.
8. **Produktion:** Multi-Arch-Build, Deployment auf ZimaOS, finale Dokumentation.

Jede Etappe endet mit validierten Tests und einer Anleitung zur lokalen Verifizierung.
