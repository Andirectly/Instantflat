# Fredy → Instantflat: Ingest-Weg

Quelle: `lib/notification/adapter/http.js` in orangecoding/fredy (Stand Release 30.1.2).

## Entscheidung
Fredys **HTTP-Adapter** statt Apprise. Der Apprise-Adapter schickt nur `{title, body}` mit Fließtext
(Adresse, Preis, Link) und müsste geparst werden. Der HTTP-Adapter sendet strukturiertes JSON.
Fredy bleibt unverändert (reines Image), Konfiguration passiert in Fredys UI.

## Einrichtung in Fredy (UI, Port 9998)
Job → Benachrichtigung → Adapter **HTTP**:
- Endpoint URL: `http://instantflat:8080/api/ingest`
- Auth token: Wert von `INGEST_TOKEN` aus `.env` (kommt als `Authorization: Bearer …`)

## Payload
```json
{ "jobId": "…", "provider": "immoscout", "timestamp": "…",
  "listings": [{ "id": "123", "title": "…", "address": "…", "price": "1.240 €", "size": "38 m²",
                 "description": "…", "imageUrl": "…", "url": "…", "images": [{"url":"…","caption":"…","floorPlan":true}] }] }
```
Preisänderungen kommen mit `"event": "priceChange"` und `priceChanges` statt `listings`; Etappe 1 ignoriert sie.

## Umsetzung
- `POST /api/ingest`: Bearer-Token (timing-safe), Zod-Validierung, 400 bei kaputter Payload.
- Provider-Mapping `immoscout → immoscout24`; unbekannte Provider werden unverändert gespeichert.
- Idempotenz: `UNIQUE(portal, external_id)` + `INSERT OR IGNORE`. Mehrfachzustellung durch Fredy erzeugt keine Dubletten.
- Rohdaten pro Inserat bleiben in `listings.raw`.

## Offen / ungeprüft
- Reale Payloads aller drei Portale liegen noch nicht vor (nur nach Doku getestet). Bei Fredy-Updates Format erneut prüfen.
- Ob die Inserat-ID von Fredy stabil pro Portal ist, zeigt sich im Realbetrieb.
- Fredys Detail-Abruf ("provider details") liefert ggf. mehr Felder (Beschreibung, Bilder); Etappe 2.

## Verifiziert (Docker, Fredy 30.1.2)
Der echte Fredy-Container hat über "Benachrichtigung testen" (`POST /api/jobs/notificationAdapter/try`, Adapter `http`) seine Test-Payload an
`http://instantflat:8080/api/ingest` geschickt (Bearer-Token). Ergebnis: HTTP 200, Inserat gespeichert, Preis/Fläche/Zimmer korrekt geparst.
Auffällig: In der Test-Payload ist `provider` = "TestCall" und `url` leer; echte Inserate bringen Portalname und Link mit.
Noch offen: ein echter Suchlauf eines Jobs gegen die Portale (bewusst nicht ausgelöst).
