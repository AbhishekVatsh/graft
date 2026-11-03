#!/bin/bash
# Build a signed, installable Graft .zxp in dist/.
#
#   ./build.sh
#
# Needs Adobe's ZXPSignCmd (https://github.com/Adobe-CEP/CEP-Resources,
# ZXPSignCMD/4.1.3/macOS). Looks in tools/ZXPSignCmd, then $ZXPSIGNCMD, then PATH.
#
# The first run creates a self-signed certificate in cert/ and a random
# password next to it. Keep both: later versions must be signed with the same
# certificate. Neither belongs in a public repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="$ROOT/cert"
CERT="$CERT_DIR/graft.p12"
PASS_FILE="$CERT_DIR/password.txt"
TSA="http://timestamp.digicert.com"

# Certificate subject. Change before the first build if you like.
CERT_COUNTRY="IN"
CERT_STATE="Maharashtra"
CERT_ORG="Graft"
CERT_NAME="Graft"

SIGN="${ZXPSIGNCMD:-}"
[ -z "$SIGN" ] && [ -x "$ROOT/tools/ZXPSignCmd" ] && SIGN="$ROOT/tools/ZXPSignCmd"
[ -z "$SIGN" ] && SIGN="$(command -v ZXPSignCmd || true)"
if [ -z "$SIGN" ]; then
  echo "ZXPSignCmd not found. Put it at tools/ZXPSignCmd or set ZXPSIGNCMD." >&2
  exit 1
fi

VERSION="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$ROOT/CSXS/manifest.xml")"
OUT="$ROOT/dist/Graft-$VERSION.zxp"

# Only what the panel needs at runtime. No .debug: it opens a debugging port.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/Graft"
cp -R "$ROOT/CSXS" "$ROOT/css" "$ROOT/js" "$ROOT/jsx" "$ROOT/index.html" "$STAGE/Graft/"
# Finder files, and the "._" metadata files macOS writes on non-Apple drives.
find "$STAGE/Graft" \( -name ".DS_Store" -o -name "._*" \) -delete
# Files copied off an exFAT drive come out owner-only; installs must be world-readable.
chmod -R u=rwX,go=rX "$STAGE/Graft"

if [ ! -f "$CERT" ]; then
  mkdir -p "$CERT_DIR"
  openssl rand -hex 16 > "$PASS_FILE"
  chmod 600 "$PASS_FILE"
  "$SIGN" -selfSignedCert "$CERT_COUNTRY" "$CERT_STATE" "$CERT_ORG" "$CERT_NAME" "$(cat "$PASS_FILE")" "$CERT"
  echo "Created certificate $CERT"
fi

mkdir -p "$ROOT/dist"
rm -f "$OUT"
# Timestamping keeps the signature valid after the certificate expires.
if ! "$SIGN" -sign "$STAGE/Graft" "$OUT" "$CERT" "$(cat "$PASS_FILE")" -tsa "$TSA"; then
  echo "Timestamp server unreachable; signing without a timestamp." >&2
  "$SIGN" -sign "$STAGE/Graft" "$OUT" "$CERT" "$(cat "$PASS_FILE")"
fi

"$SIGN" -verify "$OUT"
echo "Built $OUT"
