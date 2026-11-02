FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb x11vnc novnc websockify socat fonts-liberation ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*
COPY start.sh /start.sh
RUN chmod +x /start.sh
# 6080 = noVNC (nur über den App-Proxy nutzen), 9223 = CDP (nur im Docker-Netz). Keine Ports nach außen veröffentlichen.
EXPOSE 6080 9223
VOLUME /profile
ENTRYPOINT ["/start.sh"]
