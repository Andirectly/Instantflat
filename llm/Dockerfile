# llama-server aus PrismMLs llama.cpp-Fork (nötig für Ternary-Bonsai). Ungetestet: auf diesem Rechner gibt es kein Docker.
FROM debian:bookworm-slim AS build
ARG TARGETARCH
# Commit des Branches "prism" zum Zeitpunkt der Einrichtung; bewusst anheben, wenn Upstream das Format übernimmt.
ARG PRISM_REF=5628c7338963b00a598f2a588fd09a79af6d70db
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/PrismML-Eng/llama.cpp /src && cd /src && git checkout "$PRISM_REF"
WORKDIR /src
# amd64: AVX2 fest einschalten (Intel i5 ab ~2015), damit ein Image auf allen amd64-Servern läuft. arm64: Compiler-Standard.
RUN if [ "$TARGETARCH" = "amd64" ]; then FLAGS="-DGGML_NATIVE=OFF -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON"; else FLAGS=""; fi \
 && cmake -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DBUILD_SHARED_LIBS=OFF $FLAGS \
 && cmake --build build -j"$(nproc)" --target llama-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/bin/llama-server /usr/local/bin/llama-server
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8081
ENTRYPOINT ["/entrypoint.sh"]
