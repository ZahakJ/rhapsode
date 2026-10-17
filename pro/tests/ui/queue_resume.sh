#!/bin/sh
# Queue an export from the editor's Export panel, kill -9 the editor while it renders, start it
# again: the export must come back by itself and finish whole (with smart render, the stretches
# finished before the kill are reused).
set -eu
BIN="$1"; WORK="$2"
rm -rf "$WORK" && mkdir -p "$WORK/home" && cd "$WORK"
export HOME="$WORK/home"
ffmpeg -nostdin -loglevel error -y -f lavfi -i testsrc2=s=1920x1080:r=30:d=20 -f lavfi -i sine=f=440:d=20 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest long.mp4
"$BIN/rpro" new long.rpro long.mp4 >/dev/null
cat > queue.script <<'S'
5 move 100 35
6 down 100 35
7 up 100 35
12 move 50 232
13 down 50 232
14 up 50 232
S
"$BIN/rhapsode-pro" long.rpro --script queue.script --screenshot "$WORK/first.png" --frames 100000000 >/dev/null 2>&1 &
APP=$!
# wait until the export is running, then kill the editor hard
for i in $(seq 1 200); do grep -q '"state": 1' "$HOME/.local/share/rhapsode-pro/queue.json" 2>/dev/null && break; sleep 0.05; done
sleep 1.5
kill -9 $APP; wait $APP 2>/dev/null || true
OUT=$(python3 -c 'import json,os; print(json.load(open(os.environ["HOME"]+"/.local/share/rhapsode-pro/queue.json"))[0]["output"])')
python3 -c 'import json,os; j=json.load(open(os.environ["HOME"]+"/.local/share/rhapsode-pro/queue.json")); assert j[0]["state"]==1, j'
# the editor comes back; the queue resumes on its own
"$BIN/rhapsode-pro" long.rpro --screenshot "$WORK/second.png" --frames 100000000 >/dev/null 2>&1 &
APP=$!
for i in $(seq 1 600); do grep -q '"state": 2' "$HOME/.local/share/rhapsode-pro/queue.json" 2>/dev/null && break; sleep 0.1; done
kill $APP 2>/dev/null; wait $APP 2>/dev/null || true
python3 -c 'import json,os; j=json.load(open(os.environ["HOME"]+"/.local/share/rhapsode-pro/queue.json")); assert j[0]["state"]==2, j; assert "resumed" in j[0]["title"], j'
N=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$OUT")
[ "$N" = 600 ] || { echo "resumed export has $N frames, want 600"; exit 1; }
echo "queue resume: killed mid-export, came back, $N/600 frames"
