import { serve } from "@hono/node-server"
import path from "node:path"
import { loadConfig } from "./config.ts"
import { openDb } from "./db.ts"
import { createApp } from "./app.ts"
import { detectEncoder, selfTestDrawtext, ytdlpVersion } from "./render/encoder.ts"
import { SAFE_PATH } from "./render/graph.ts"
import { startSweeper } from "./sweep.ts"

const config = loadConfig()

for (const [name, p] of [["DATA_DIR", config.dataDir], ["FONT_PATH", config.fontPath]] as const) {
  if (!SAFE_PATH.test(p)) {
    console.error(`[rhapsode] ${name} "${p}" contains characters ffmpeg filter strings cannot carry — use [A-Za-z0-9_./-]`)
    process.exit(1)
  }
}

const encoder = await detectEncoder(config.renderEncoder)
const fontProblem = await selfTestDrawtext(config.fontPath)
const ytdlp = await ytdlpVersion()
console.log(`[rhapsode] encoder ${encoder}${config.renderEncoder ? " (forced)" : ""} · yt-dlp ${ytdlp ?? "MISSING"}`)
if (fontProblem) console.warn(`[rhapsode] ⚠ caption font failed to load — captions will fail at render time: ${fontProblem}`)
if (!ytdlp) console.warn("[rhapsode] ⚠ yt-dlp not found on PATH — link sources will fail")

const db = openDb(path.join(config.dataDir, "rhapsode.sqlite"))
const { app, store, queue } = createApp(config, db, { encoder, ytdlpVersion: ytdlp })
const stale = queue.recoverAtBoot()
if (stale) console.log(`[rhapsode] failed ${stale} job(s) left over from the previous run`)
startSweeper(store, config)

if (!config.inviteKey) {
  console.warn("[rhapsode] INVITE_KEY is empty — adding sources and rendering are disabled")
} else if (config.inviteKey.length < 12) {
  // warn, never refuse: a hard exit here would brick a live deployment
  console.warn(
    [
      "",
      "  ══════════════════════════════════════════════════════════",
      "   ⚠  WEAK INVITE_KEY — under 12 characters.",
      "   One shared secret guards every write route, and short keys",
      "   fall to guessing. Replace it with a long passphrase:",
      "       openssl rand -base64 24",
      "  ══════════════════════════════════════════════════════════",
      "",
    ].join("\n"),
  )
}

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[rhapsode] listening on http://${info.address}:${info.port}`)
})

// cloudflared resolves "localhost" to ::1 first — bind the IPv6 loopback too,
// or the tunnel 502s. Still loopback-only; nothing external can reach either.
if (config.host === "127.0.0.1") {
  serve({ fetch: app.fetch, hostname: "::1", port: config.port }, (info) => {
    console.log(`[rhapsode] listening on http://[${info.address}]:${info.port}`)
  })
}
