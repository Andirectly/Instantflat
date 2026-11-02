# Portal-Kalibrierung (Stand 02.11.2026)

Die Selektoren liegen in `config/portals.json` (ohne Zugangsdaten, im Repo). Auf dem Server nach
`/DATA/AppData/instantflat/data/portals.json` kopieren oder per `PORTALS_CONFIG` auf die Datei zeigen.

| Portal | Anmeldung | Formular | Erfolg | Status |
|---|---|---|---|---|
| ImmoScout24 | `logout-button` auf `/meinkonto/` | Öffner "Interesse bekunden", dann `contact-form` | Dialog "Interesse bekundet" | live bestätigt (Senden manuell beobachtet) |
| Immowelt | `UserButton-account-in` auf `/meinbereich/consumer-hub` | `cdp-contact-form` direkt, Feld ist vorbefüllt (wird geleert) | `cdp-confirm-page` | live bestätigt |
| WG-Gesucht | `a.logout_button` auf `/mein-wg-gesucht-filter.html` | Link `/nachricht-senden/` öffnet `form#messenger_form` | `#message_successfully_sent:visible` | live bestätigt, nur native Anzeigen |
| Kleinanzeigen | – | – | – | nicht kalibriert (IP-Sperre bei Login-Versuch) |

## Bekannte Lücken
- Der `loggedOut`-Selektor ist bei Immowelt und WG-Gesucht geraten (ausgeloggte Seite nicht gesehen). `requireLoggedIn` verhindert Versand als Gast trotzdem.
- Der Captcha-Selektor (`interaction`) ist bei allen Portalen nur geraten (nie ein echtes Captcha gesehen).
- ImmoScout24: Normale Inserate (nicht Mieter-Netzwerk) haben vermutlich einen anderen Knopf.
- WG-Gesucht: Anzeigen von Drittanbietern leiten extern weiter, dort sendet Instantflat nie (Host-Schutz `host: wg-gesucht.de`).

## Neu kalibrieren, wenn ein Portal sein Layout ändert
1. Im Server-Browser anmelden, Inserat öffnen.
2. `POST /api/portals/<id>/probe` mit `{"url": "..."}` zeigt, wie oft jeder Selektor trifft.
3. Selektor in `portals.json` anpassen, "Jetzt prüfen" in den Einstellungen, Dry-Run abwarten.
Tipp: Erfolgs- und Captcha-Selektoren mit `:visible` verwenden, sonst treffen versteckte Elemente im HTML.
