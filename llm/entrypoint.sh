#!/bin/sh
# Lädt das Modell beim ersten Start in das Volume /models (einmalig ~2,2 GB), prüft die Prüfsumme und startet den Server.
set -eu
# PQ2_0: passt zum gepinnten PrismML-Fork (die Q2_0-Datei nutzt ein älteres Layout und lädt dort nicht)
FILE=/models/Ternary-Bonsai-8B-PQ2_0.gguf
URL=https://huggingface.co/prism-ml/Ternary-Bonsai-8B-gguf/resolve/main/Ternary-Bonsai-8B-PQ2_0.gguf
SHA256=1376f942aa90e60f7b570c1d81b3916fea1315ff85aa1c4d19006af68fb4b922

if [ ! -f "$FILE" ]; then
  echo "Lade Modell (~2,2 GB) ..."
  curl -fL --retry 5 --retry-delay 10 -C - -o "$FILE.part" "$URL"
  echo "$SHA256  $FILE.part" | sha256sum -c -
  mv "$FILE.part" "$FILE"
fi

# Kontext klein halten (RAM). Eine Anfrage zur Zeit: die App serialisiert ohnehin.
exec llama-server -m "$FILE" --host 0.0.0.0 --port 8081 -c "${LLM_CTX:-4096}" -t "${LLM_THREADS:-4}" -np 1 --jinja
