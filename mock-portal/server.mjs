// Mock-Portal für Tests: Login-Seite, eingeloggter Bereich, Session-Ablauf und Captcha per Knopfdruck. Keine Abhängigkeiten.
import { createServer } from "node:http";

const state = { loggedIn: false, captcha: false };
const page = (body) => `<!doctype html><meta charset="utf-8"><title>Mock-Portal</title><body style="font-family:sans-serif">${body}`;

const sent = []; // empfangene Nachrichten, damit Tests "genau einmal gesendet" belegen können
const loginForm = `<form id="login" method="post" action="/login"><input name="user"><input name="pw" type="password"><button>Anmelden</button></form>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (html, code = 200) => (res.writeHead(code, { "content-type": "text/html; charset=utf-8" }), res.end(html));

  const expose = url.pathname.match(/^\/expose\/(\d+)(\/send)?$/);
  if (expose) {
    if (state.captcha) return send(page(`<div id="captcha">Bitte bestätigen</div>${loginForm}`));
    if (!state.loggedIn) return send(page(loginForm));
    // Inserat 2: Formular erscheint erst nach Klick auf "Interesse bekunden" (wie bei ImmoScout24)
    if (!expose[2] && expose[1] === "2") return send(page(`<div id="account">Mein Konto</div><h1>Inserat 2</h1><div id="slot"></div><button id="open-contact" onclick="document.getElementById('slot').innerHTML='<form id=contact method=post action=/expose/2/send><textarea id=message name=message></textarea><button id=send>Senden</button></form>'">Interesse bekunden</button>`));
    if (!expose[2]) return send(page(`<div id="account">Mein Konto</div><h1>Inserat ${expose[1]}</h1><form id="contact" method="post" action="/expose/${expose[1]}/send"><textarea id="message" name="message"></textarea><button id="send">Senden</button></form>`));
    let raw = "";
    req.on("data", (c) => (raw += c));
    return req.on("end", () => {
      sent.push({ id: expose[1], message: new URLSearchParams(raw).get("message") });
      send(page(`<div id="account">Mein Konto</div><div id="sent-ok">Nachricht gesendet</div>`));
    });
  }

  switch (url.pathname) {
    case "/__sent": res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(sent));
    case "/__reset": sent.length = 0; return send("ok");
    case "/": {
      if (state.captcha) return send(page(`<div id="captcha">Bitte bestätigen: Ich bin kein Roboter</div><form id="login"></form>`));
      return send(state.loggedIn
        ? page(`<div id="account">Mein Konto</div>`)
        : page(`<form id="login" method="post" action="/login"><input name="user"><input name="pw" type="password"><button>Anmelden</button></form>`));
    }
    case "/login": state.loggedIn = true; res.writeHead(303, { location: "/" }); return res.end();
    // Steuerung für Tests (GET, damit sie sich per Browser oder curl auslösen lässt)
    case "/__login": state.loggedIn = true; return send("ok");
    case "/__expire": state.loggedIn = false; return send("ok");
    case "/__captcha": state.captcha = true; return send("ok");
    case "/__clear": state.captcha = false; return send("ok");
    default: return send("nicht gefunden", 404);
  }
});

const port = Number(process.env.PORT ?? 4000);
server.listen(port, "0.0.0.0", () => console.log(`Mock-Portal auf :${port}`));
export { server };
