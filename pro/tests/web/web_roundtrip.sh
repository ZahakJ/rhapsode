#!/bin/sh
# Quick mode → Pro → share link, against a real Rhapsode server on a spare port:
# upload two pieces, render a PiP in quick mode, open that render in Pro
# (originals downloaded), export it from Pro and publish it back as a link.
set -eu
BIN="$1"; WORK="$2"; REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT=${RHAP_WEB_PORT:-6955}
export RHAPSODE_KEY="roundtrip-key-long-enough"
rm -rf "$WORK" && mkdir -p "$WORK/data" && cd "$WORK"
ffmpeg -nostdin -loglevel error -y -f lavfi -i testsrc2=s=640x360:r=30:d=3 -f lavfi -i sine=f=440:d=3 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest base.mp4
ffmpeg -nostdin -loglevel error -y -f lavfi -i smptehdbars=s=320x240:r=30:d=2 -f lavfi -i sine=f=660:d=2 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest clip.mp4
( cd "$REPO" && PORT=$PORT DATA_DIR="$WORK/data" INVITE_KEY="$RHAPSODE_KEY" RATE_LIMIT=0 RENDER_ENCODER=libx264 \
    PUBLIC_ORIGIN="http://127.0.0.1:$PORT" exec node server/index.ts ) > server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for i in $(seq 1 100); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.1; done
H="x-rhapsode-key: $RHAPSODE_KEY"
up() { curl -sf -X POST -H "$H" -H "content-type: application/octet-stream" -H "x-filename: $1" --data-binary "@$1" "http://127.0.0.1:$PORT/api/sources"; }
wait_job() { for i in $(seq 1 300); do s=$(curl -sf -H "$H" "http://127.0.0.1:$PORT/api/jobs/$1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])'); [ "$s" = done ] && return 0; [ "$s" = failed ] && return 1; sleep 0.1; done; return 1; }
B=$(up base.mp4); C=$(up clip.mp4)
BID=$(echo "$B" | python3 -c 'import json,sys; print(json.load(sys.stdin)["source"]["id"])')
CID=$(echo "$C" | python3 -c 'import json,sys; print(json.load(sys.stdin)["source"]["id"])')
for j in $(echo "$B$C" | python3 -c 'import json,sys,re; [print(m) for m in re.findall(r"\"job\":\{\"id\":\"([0-9a-f]+)", sys.stdin.read())]'); do wait_job "$j"; done
R=$(curl -sf -X POST -H "$H" -H "content-type: application/json" "http://127.0.0.1:$PORT/api/renders" \
  -d "{\"title\":\"quick pip\",\"recipe\":{\"v\":1,\"base\":{\"kind\":\"video\",\"source\":\"$BID\",\"in\":0,\"out\":3},\"overlay\":{\"source\":\"$CID\",\"in\":0,\"out\":2,\"at\":0.5},\"mode\":{\"kind\":\"pip\",\"box\":{\"x\":0.55,\"y\":0.05,\"w\":0.4}}}}")
SLUG=$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["slug"])')
wait_job "$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["job"]["id"])')"

"$BIN/rpro" open-web "http://127.0.0.1:$PORT/m/$SLUG" "$WORK/quick.rpro"
"$BIN/rpro" info quick.rpro > quick.json
python3 - quick.json <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
t = {x["track"]: x["clips"] for x in j["tracks"]}
assert j["size"] == [640, 360], j["size"]
assert len(t["V1"]) == 1 and abs(t["V1"][0]["end"] - 3) < 1e-3, t["V1"]          # the base
assert len(t["V2"]) == 1 and abs(t["V2"][0]["start"] - 0.5) < 1e-3, t["V2"]      # the clip, at 0.5 s
assert any(x["clips"] for k, x in [(x["track"], x) for x in j["tracks"]] if k.startswith("A")), "sound came along"
PY
"$BIN/rpro" export quick.rpro youtube-1080p "$WORK/pro.mp4" --native-size --publish "http://127.0.0.1:$PORT" --title "made in pro" > export.json
LINK=$(python3 -c 'import json; print(json.load(open("export.json"))["shareUrl"])')
curl -sf "$LINK" | grep -q "made in pro"
PSLUG=${LINK##*/}
curl -sf "http://127.0.0.1:$PORT/api/renders/$PSLUG" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["origin"]=="pro" and d["width"]==640, d'
echo "web round trip: quick render $SLUG → Pro → $LINK"
