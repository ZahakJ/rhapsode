#!/bin/sh
# Drives the real editor headless (SDL offscreen) with scripted input and checks the project it saves:
# a mouse drag moves V1's first clip (and its linked sound) by one second, M adds a marker.
set -eu
BIN="$1"; WORK="$2"; SRC="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$WORK" && cd "$WORK"
for i in 0 1; do
  [ -f clip$i.mp4 ] || ffmpeg -nostdin -loglevel error -threads 2 -f lavfi -i "testsrc2=s=1920x1080:r=30:d=8" \
    -f lavfi -i "sine=frequency=440:duration=8" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest clip$i.mp4
done
"$BIN/rpro" new start.rpro clip0.mp4 clip1.mp4 >/dev/null
sed "s#@OUT@#$WORK/after.rpro#" "$SRC/drag-move.script" > drag.script
"$BIN/rhapsode-pro" start.rpro --script drag.script --screenshot "$WORK/after.png" --frames 30 >/dev/null 2>&1
"$BIN/rpro" info after.rpro > after.json
python3 - "$WORK/after.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
t = {x["track"]: x["clips"] for x in j["tracks"]}
v1, a1 = t["V1"], t["A1"]
assert abs(v1[0]["start"] - 1.0) < 1e-6, v1
assert abs(a1[0]["start"] - 1.0) < 1e-6, a1          # the linked sound moved with it
assert abs(v1[1]["start"] - 9.0) < 1e-6 and abs(v1[1]["in"] - 1.0) < 1e-6, v1  # overwrite cut the next clip's head
assert j["markers"] == 1, j
print("ui smoke: drag-move and marker ok")
PY
