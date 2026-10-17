#!/bin/sh
# The benchmark campaign behind docs/BENCHMARKS.md. Run it holding the machine's GPU lock:
#   flock /tmp/side-gpu.lock sh pro/tools/bench.sh
# Everything is measured on this machine, the same composition in each tool:
# three 4K60 HEVC 10-bit tracks, the base full frame, two graded, scaled, rotated PiPs.
set -eu
PRO="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$PRO/build/bin"; OUT="$PRO/../docs/benchmarks"; B="$PRO/build/bench"
mkdir -p "$OUT" "$B"
export RPRO_HOLDS_GPU_LOCK=1
cd "$PRO"
info() { echo "== $*" >&2; }
{ nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader; lscpu | grep "Model name"; uname -r; } > "$OUT/machine.txt"

info "sources"
"$BIN/rpro" bench playback --prepare
info "rhapsode pro: paced playback (real time, 60 s)"
"$BIN/rpro" bench playback > "$OUT/pro-playback-4k60x3.json"
info "rhapsode pro: unpaced throughput"
"$BIN/rpro" bench playback --unpaced > "$OUT/pro-throughput-4k60x3.json"
info "rhapsode pro: 1080p30 H.264, 3 tracks"
"$BIN/rpro" bench playback --size 1920x1080 --fps 30 --codec h264 > "$OUT/pro-playback-1080p30x3.json"
info "rhapsode pro: export HEVC 10-bit 4K (NVENC)"
"$BIN/rpro" bench export --preset youtube-4k > "$OUT/pro-export-4k-hevc.json"
info "rhapsode pro: export ProRes 422 HQ 4K"
"$BIN/rpro" bench export --preset prores-hq > "$OUT/pro-export-4k-prores.json"

info "kdenlive (MLT $(flatpak run --command=melt org.kde.kdenlive -version 2>&1 | head -1))"
python3 - "$B" > "$B/bench.mlt" <<'PY'
import sys, glob, os
b = sys.argv[1]
srcs = sorted(glob.glob(os.path.join(b, "src[0-9]-hevc10-3840x2160p60-60s.mp4")))[:3]
n = 3600
rects = ["0 0 3840 2160 1", "1901 162 1728 972 1", "211 1026 1728 972 1"]  # the base, then the PiPs as rpro places them
x = ['<?xml version="1.0" encoding="utf-8"?>', '<mlt LC_NUMERIC="C" version="7.0.0">',
     '<profile description="4K60" width="3840" height="2160" progressive="1" sample_aspect_num="1" sample_aspect_den="1" '
     'display_aspect_num="16" display_aspect_den="9" frame_rate_num="60" frame_rate_den="1" colorspace="709"/>']
for i, s in enumerate(srcs):
    x.append(f'<producer id="p{i}"><property name="resource">{s}</property></producer>')
    x.append(f'<playlist id="pl{i}"><entry producer="p{i}" in="0" out="{n-1}">')
    if i:
        x.append('<filter mlt_service="avfilter.eq"><property name="av.saturation">1.2</property><property name="av.contrast">1.05</property></filter>')
    x.append('</entry></playlist>')
x.append(f'<tractor id="main" in="0" out="{n-1}">')
for i in range(len(srcs)):
    x.append(f'<track producer="pl{i}"/>')
for i in range(1, len(srcs)):
    x.append(f'<transition mlt_service="qtblend"><property name="a_track">0</property><property name="b_track">{i}</property>'
             f'<property name="rect">{rects[i]}</property><property name="rotation">{3*i}</property></transition>')
    x.append(f'<transition mlt_service="mix"><property name="a_track">0</property><property name="b_track">{i}</property>'
             '<property name="always_active">1</property><property name="sum">1</property></transition>')
x.append('</tractor></mlt>')
print("\n".join(x))
PY
MELT="flatpak run --filesystem=$B --command=melt org.kde.kdenlive"
info "kdenlive: throughput to a null consumer (its playback engine, unthrottled)"
/usr/bin/time -f '{"wall_s": %e, "max_rss_kb": %M}' $MELT "$B/bench.mlt" -consumer null real_time=-4 terminate_on_pause=1 \
  > /dev/null 2> "$B/melt-null.log" || true
tail -1 "$B/melt-null.log" > "$OUT/kdenlive-throughput-4k60x3.json"
info "kdenlive: export HEVC (the best encoder its flatpak offers)"
VC=$($MELT -query video_codecs 2>/dev/null | grep -oE "hevc_nvenc|libx265" | head -1 || echo libx265)
/usr/bin/time -f '{"wall_s": %e, "max_rss_kb": %M, "vcodec": "'"$VC"'"}' $MELT "$B/bench.mlt" \
  -consumer avformat:"$B/kdenlive-export.mp4" vcodec=$VC pix_fmt=yuv420p10le vb=40M acodec=aac real_time=-4 \
  > /dev/null 2> "$B/melt-export.log" || true
tail -1 "$B/melt-export.log" > "$OUT/kdenlive-export-4k-hevc.json"

info "ffmpeg floor: the same composition as one filter graph, NVDEC + NVENC"
S0=$(ls "$B"/src0-hevc10-3840x2160p60-60s.mp4); S1=$(ls "$B"/src1-hevc10-3840x2160p60-60s.mp4); S2=$(ls "$B"/src2-hevc10-3840x2160p60-60s.mp4)
/usr/bin/time -f '{"wall_s": %e, "max_rss_kb": %M}' ffmpeg -nostdin -loglevel error -y -hwaccel cuda -i "$S0" -hwaccel cuda -i "$S1" -hwaccel cuda -i "$S2" \
  -filter_complex "[1]eq=saturation=1.2,scale=1728:-2,rotate=3*PI/180:c=none:ow=rotw(3*PI/180):oh=roth(3*PI/180)[a];[2]eq=saturation=1.2,scale=1728:-2,rotate=6*PI/180:c=none:ow=rotw(6*PI/180):oh=roth(6*PI/180)[b];[0][a]overlay=1901:162[o];[o][b]overlay=211:1026,format=p010le" \
  -c:v hevc_nvenc -profile:v main10 -preset p5 -cq 21 -c:a aac "$B/ffmpeg-floor.mp4" 2> "$B/ffmpeg-floor.time" || true
tail -1 "$B/ffmpeg-floor.time" > "$OUT/ffmpeg-floor-4k-hevc.json"
info "task 1: a 20-minute interview to about 5 minutes with captions"
"$BIN/rpro" bench interview --minutes 20 > "$OUT/pro-task-interview.json"
info "done"
