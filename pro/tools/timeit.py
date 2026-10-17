"""timeit.py OUT.json [key=value ...] -- CMD...  : runs CMD, writes {"wall_s", "max_rss_kb", "exit", key: value...}"""
import json, os, sys, time
i = sys.argv.index("--")
out, extra, cmd = sys.argv[1], dict(a.split("=", 1) for a in sys.argv[2:i]), sys.argv[i + 1:]
t0 = time.monotonic()
pid = os.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
_, status, ru = os.wait4(pid, 0)
res = {"wall_s": round(time.monotonic() - t0, 3), "max_rss_kb": ru.ru_maxrss, "exit": os.waitstatus_to_exitcode(status), **extra}
json.dump(res, open(out, "w"), indent=1)
print(json.dumps(res))
