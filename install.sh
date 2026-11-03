#!/bin/bash
# Install Graft for development: links this folder into Adobe's CEP
# extensions folder and allows unsigned extensions to load.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.graft.panel"

mkdir -p "$(dirname "$DEST")"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
  echo "Refusing to overwrite a real folder at: $DEST" >&2
  exit 1
fi
ln -sfn "$SRC" "$DEST"

# Unsigned extensions only load with PlayerDebugMode on. AE 2022-2026 use CSXS 11/12.
for v in 11 12; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done

echo "Linked $DEST -> $SRC"
echo "Restart After Effects, then open Window > Extensions > Graft."
