#!/bin/sh
set -eu
export DISPLAY=:99
RES="${SCREEN:-1280x800}"

Xvfb :99 -screen 0 "${RES}x24" -nolisten tcp &
sleep 1
x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 -quiet &
websockify --web /usr/share/novnc 6080 localhost:5900 &
# Chromium bindet CDP nur an localhost; socat macht ihn im Docker-Netz erreichbar.
socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222 &

# Läuft Chromium nicht mehr (Absturz), startet er neu; das Profil im Volume bleibt erhalten.
while true; do
  rm -f /profile/SingletonLock /profile/SingletonCookie /profile/SingletonSocket
  # --no-sandbox: der Container selbst ist die Isolation (kein User-Namespace im Standard-Seccomp-Profil).
  chromium --no-sandbox --user-data-dir=/profile --remote-debugging-port=9222 \
    --no-first-run --no-default-browser-check --window-size="${RES%x*},${RES#*x}" --start-maximized \
    --disable-features=Translate about:blank || true
  sleep 2
done
