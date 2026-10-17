"""Our interchange files against the reference implementation (OpenTimelineIO
and its cmx_3600 / fcp_xml / fcpx_xml adapters), in both directions:
  1. files Rhapsode writes are read by OTIO with the same cuts
  2. files OTIO writes are read by Rhapsode with the same cuts
usage: python otio_check.py RPRO_BIN WORKDIR CLIP_A CLIP_B
"""
import json, subprocess, sys, os
import opentimelineio as otio

rpro, work, a, b = sys.argv[1:5]
os.makedirs(work, exist_ok=True)
os.chdir(work)
seq = {"v": 1, "canvas": {"aspect": "16:9", "fps": 30}, "tracks": [
    {"id": "v1", "kind": "visual", "clips": [
        {"id": "c1", "source": a, "at": 0, "duration": 2.5, "in": 1.0},
        {"id": "c2", "source": b, "at": 2.5, "duration": 3.0, "in": 0.5},
        {"id": "c3", "source": a, "at": 6.0, "duration": 1.5, "in": 4.0}]},
    {"id": "v2", "kind": "visual", "clips": [{"id": "c4", "source": b, "at": 1.0, "duration": 2.0, "in": 3.0, "volume": 0}]}]}
json.dump(seq, open("seq.json", "w"))
subprocess.run([rpro, "convert", "seq.json", "ref.rpro"], check=True)

def ours(path):
    info = json.loads(subprocess.run([rpro, "info", path], check=True, capture_output=True, text=True).stdout)
    return {t["track"]: [(round(c["start"], 3), round(c["end"] - c["start"], 3), round(c["in"], 3)) for c in t["clips"]] for t in info["tracks"]}

def theirs(tl):
    if isinstance(tl, otio.schema.SerializableCollection):
        tl = next(iter(tl.find_children(descended_from_type=otio.schema.Timeline)), None) or list(tl)[0]
    out = {}
    v = a_ = 0
    for t in tl.tracks:
        kind = "V" if t.kind == otio.schema.TrackKind.Video else "A"
        idx = (v := v + 1) if kind == "V" else (a_ := a_ + 1)
        clips = []
        for c in t.find_clips():
            r = t.range_of_child(c)
            clips.append((round(r.start_time.to_seconds(), 3), round(r.duration.to_seconds(), 3), round(c.trimmed_range().start_time.to_seconds(), 3)))
        out[f"{kind}{idx}"] = clips
    return out

ref = ours("ref.rpro")
fails = 0
# 1. ours → OTIO
for ext, adapter, tracks in [("otio", "otio_json", ["V1", "V2"]), ("xml", "fcp_xml", ["V1", "V2"]), ("fcpxml", "fcpx_xml", ["V1"]), ("edl", "cmx_3600", ["V1"])]:
    subprocess.run([rpro, "convert", "ref.rpro", f"ours.{ext}"], check=True)
    kw = {"rate": 30} if adapter == "cmx_3600" else {}
    tl = otio.adapters.read_from_file(f"ours.{ext}", adapter_name=adapter, **kw)
    got = theirs(tl)
    for tr in tracks:
        if got.get(tr) != ref[tr]:
            fails += 1
            print(f"ours→OTIO {ext} {tr}: OTIO reads {got.get(tr)} want {ref[tr]}")
    print(f"ours→OTIO {ext}: {'ok' if all(got.get(t) == ref[t] for t in tracks) else 'MISMATCH'}")
# 2. OTIO → ours
tl = otio.adapters.read_from_file("ours.otio")
for ext, adapter, tracks in [("xml", "fcp_xml", ["V1", "V2"]), ("fcpxml", "fcpx_xml", ["V1"]), ("edl", "cmx_3600", ["V1"])]:
    path = f"theirs.{ext}"
    if adapter == "cmx_3600":
        one = otio.schema.Timeline(name="edl")
        one.tracks.append(tl.video_tracks()[0].deepcopy())
        otio.adapters.write_to_file(one, path, adapter_name=adapter)
    else:
        otio.adapters.write_to_file(tl, path, adapter_name=adapter)
    subprocess.run([rpro, "convert", path, f"theirs-{ext}.rpro"], check=True)
    got = ours(f"theirs-{ext}.rpro")
    for tr in tracks:
        if got.get(tr) != ref[tr]:
            fails += 1
            print(f"OTIO→ours {ext} {tr}: we read {got.get(tr)} want {ref[tr]}")
    print(f"OTIO→ours {ext}: {'ok' if all(got.get(t) == ref[t] for t in tracks) else 'MISMATCH'}")
sys.exit(1 if fails else 0)
