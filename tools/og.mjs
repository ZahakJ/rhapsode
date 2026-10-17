// Renders docs/assets/og.png (1200×630) from docs/media/og.html — no binary in git history that can't be regenerated.
// The README banner (docs/media/banner.png, 1640×640) comes from banner.html the same way: node tools/og.mjs banner
import { chromium } from "playwright"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
const docs = join(dirname(fileURLToPath(import.meta.url)), "..", "docs")
const banner = process.argv[2] === "banner"
const [src, out, width, height] = banner
  ? [join(docs, "media", "banner.html"), join(docs, "media", "banner.png"), 1640, 640]
  : [join(docs, "media", "og.html"), join(docs, "assets", "og.png"), 1200, 630]
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
await p.goto(pathToFileURL(src).href)
await p.evaluate(() => document.fonts.ready)
await p.waitForTimeout(300)
await p.screenshot({ path: out })
await b.close()
console.log("wrote", out)
