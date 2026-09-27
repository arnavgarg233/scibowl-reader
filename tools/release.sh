#!/bin/sh
# Bump the ?v= cache-busting tag on every script/style/data link (so browsers fetch the
# new code instead of a cached copy), commit, and push to GitHub Pages.
set -e
cd "$(dirname "$0")/.."
V=$(date +%Y%m%d%H%M)
sed -i.bak -E "s/\?v=[0-9]+/?v=$V/g" index.html js/app.js js/voice.js && rm -f index.html.bak js/*.bak
git add -A
git commit -m "${1:-Release $V}"
git push origin main
