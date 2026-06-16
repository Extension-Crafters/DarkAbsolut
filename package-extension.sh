#!/usr/bin/env bash
# Package the extension into per-browser zips.
#
# Chrome/Chromium MV3 wants  background.service_worker  and rejects
# background.scripts ("requires manifest version 2 or lower"). Firefox MV3 is
# the opposite: it has no extension service workers and wants background.scripts.
# A single manifest can only ever *warn* in one of them, so we ship one zip per
# store, each with the background block that browser accepts.
#
#   DarkAbsolut-chrome.zip    -> Chrome Web Store / Edge / Brave  (service_worker)
#   DarkAbsolut-firefox.zip   -> Mozilla AMO                      (scripts event page)
set -euo pipefail

cd "$(dirname "$0")"

CHROME_OUT="DarkAbsolut-chrome.zip"
FIREFOX_OUT="DarkAbsolut-firefox.zip"
rm -f "$CHROME_OUT" "$FIREFOX_OUT"

# Files/folders that make up the shipped extension.
INCLUDE=(
  manifest.json
  src
  invert.css
  popup
  icons
  README.md
)

# Stage a clean copy so only the files above end up in the archives.
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
cp -r "${INCLUDE[@]}" "$BUILD"/

# Strip any OS / editor junk that may live inside the copied folders.
find "$BUILD" \( -name '.DS_Store' -o -name 'Thumbs.db' -o -name '*.log' \) -delete

# ── Chrome: manifest as-is (background.service_worker) ──────────────────────
( cd "$BUILD" && zip -r -q -X "$OLDPWD/$CHROME_OUT" . )

# ── Firefox: rewrite the background block to a scripts event page ───────────
# Same ES-module entry point, just declared the way Firefox MV3 expects.
node - "$BUILD/manifest.json" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const m = JSON.parse(fs.readFileSync(path, "utf8"));
const entry = m.background.service_worker || (m.background.scripts || [])[0];
m.background = { scripts: [entry], type: m.background.type || "module" };
fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
NODE
( cd "$BUILD" && zip -r -q -X "$OLDPWD/$FIREFOX_OUT" . )

echo
echo "Created:"
du -h "$CHROME_OUT" "$FIREFOX_OUT"
