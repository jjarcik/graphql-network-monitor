#!/usr/bin/env bash
# Builds a Chrome Web Store upload: dist/graphql-network-monitor-<version>.zip
set -euo pipefail

cd "$(dirname "$0")"

version=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
out="dist/graphql-network-monitor-${version}.zip"

files=(
  manifest.json
  background.js
  devtools.html
  devtools.js
  panel.html
  panel.css
  panel.js
  hook.js
  relay.js
  about.js
  lib/graphql.js
  lib/json-view.js
  lib/curl.js
  icons/icon-16.png
  icons/icon-32.png
  icons/icon-48.png
  icons/icon-128.png
  icons/avatar.jpg
)

for f in "${files[@]}"; do
  [[ -f "$f" ]] || { echo "Missing file: $f" >&2; exit 1; }
done

mkdir -p dist
rm -f "$out"
zip -q -X "$out" "${files[@]}"
echo "$out"
