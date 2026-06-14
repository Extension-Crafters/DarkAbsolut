#!/usr/bin/env bash
# Package the extension into DarkAbsolut.zip, excluding tests, dev files and caches.
set -euo pipefail

cd "$(dirname "$0")"

OUT="DarkAbsolut.zip"
rm -f "$OUT"

# Files/folders to ship in the extension package.
INCLUDE=(
  manifest.json
  src
  invert.css
  popup
  icons
  README.md
)

# Patterns to strip from the archive (safety net).
EXCLUDES=(
  "*/node_modules/*"
  "*/.git/*"
  "*/.claude/*"
  "*/tests/*"
  "*.zip"
  "*.log"
  "*/.DS_Store"
  "test-*.js"
  "test-*.html"
  "test-*.png"
  "diag-*.png"
  "verify-*.png"
  "pixel-check.png"
)

EXCLUDE_ARGS=()
for pat in "${EXCLUDES[@]}"; do
  EXCLUDE_ARGS+=( -x "$pat" )
done

zip -r "$OUT" "${INCLUDE[@]}" "${EXCLUDE_ARGS[@]}"

echo
echo "Created $OUT"
du -h "$OUT"
