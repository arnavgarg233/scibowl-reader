#!/bin/sh
# Download every high-school sample round from the NSB site into ./pdfs and
# write link_names.json (PDF path -> link text), then run the extractor.
set -e
cd "$(dirname "$0")/.."
mkdir -p pdfs
curl -sL -A "Mozilla/5.0" https://science.osti.gov/wdts/nsb/Regional-Competitions/Resources/HS-Sample-Questions -o pdfs/index.html
python3 - <<'PY'
import re, html, json
h = open("pdfs/index.html").read()
out = {}
for m in re.finditer(r'<a[^>]+href="(/-/media/wdts/nsb/pdf/HS-Sample-Questions/[^"]+\.pdf)[^"]*"[^>]*>([\s\S]*?)</a>', h):
    out[m.group(1)] = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", m.group(2)))).strip()
json.dump(out, open("pdfs/link_names.json", "w"), indent=0)
PY
python3 -c "import json;print('\n'.join(json.load(open('pdfs/link_names.json'))))" | while read -r u; do
  f=$(echo "$u" | sed 's#.*/HS-Sample-Questions/##;s#/#__#g')
  [ -f "pdfs/$f" ] || curl -sfL -A "Mozilla/5.0" "https://science.osti.gov$u" -o "pdfs/$f"
done
python3 tools/extract.py pdfs pdfs/link_names.json
