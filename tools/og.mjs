// Renders docs/assets/og.png (1200×630) from an inline card — no binary in git history that can't be regenerated.
import { chromium } from "playwright"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "assets", "og.png")
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;width:1200px;height:630px;background:#0b0d12;color:#e8ebf0;font-family:"IBM Plex Sans","Inter",system-ui,sans-serif;display:flex;flex-direction:column;justify-content:space-between;padding:56px 72px;box-sizing:border-box;position:relative;overflow:hidden}
.top{display:flex;flex-direction:column;gap:34px}
.mark{font-family:"IBM Plex Mono",ui-monospace,monospace;font-weight:600;letter-spacing:.16em;color:#ff9f43;font-size:26px;display:flex;align-items:center;gap:14px}
.mark i{width:14px;height:14px;border-radius:50%;background:#7dd3fc;box-shadow:0 0 0 5px rgba(125,211,252,.18)}
h1{font-size:58px;line-height:1.05;margin:0;letter-spacing:-.02em;font-weight:600;max-width:1000px}
h1 span{color:#ff9f43}
p{font-size:22px;color:#9aa3b2;margin:16px 0 0;max-width:820px;line-height:1.35}
.tl{position:absolute;left:72px;right:72px;bottom:64px;height:64px;border:1px solid #2f3542;border-radius:8px;background:#12151c;overflow:hidden}
.tl .base{position:absolute;left:0;top:8px;bottom:8px;width:100%;background:rgba(255,159,67,.12)}
.tl .clip{position:absolute;left:38%;top:8px;bottom:8px;width:31%;background:#ff9f43;border-radius:4px}
.tl .head{position:absolute;left:52%;top:0;bottom:0;width:2px;background:#7dd3fc;box-shadow:0 0 12px #7dd3fc}
.tl .tc{position:absolute;right:14px;top:20px;font-family:"IBM Plex Mono",monospace;color:#7dd3fc;font-size:18px}
.sub{font-family:"IBM Plex Mono",monospace;color:#5f6774;font-size:16px;letter-spacing:.1em;text-transform:uppercase;position:absolute;left:72px;bottom:140px}
</style></head><body>
<div class="top"><div class="mark"><i></i>RHAPSODE</div>
<div><h1>Take a piece of one thing.<br>Lay it on <span>another.</span></h1>
<p>Clip any video, stitch it onto a photo or a clip, render on your own GPU, share a link that unfurls.</p></div></div>
<div class="sub">ῥαψῳδός · the cutting room · self-hosted</div>
<div class="tl"><div class="base"></div><div class="clip"></div><div class="head"></div><div class="tc">00:00:04.120</div></div>
</body></html>`
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
await p.setContent(html); await p.waitForTimeout(300); await p.screenshot({ path: out }); await b.close(); console.log("wrote", out)
