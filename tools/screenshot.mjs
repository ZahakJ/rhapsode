#!/usr/bin/env node
/**
 * Smoke test: build (unless --no-build), start the real server on :6951 with a
 * throwaway DATA_DIR and libx264, seed two clips + a photo through the actual
 * API (ffmpeg-generated, no binary fixtures in the repo), then drive the app
 * in headless Chromium: unlock with the key, pick the recent sources, render
 * through the UI, land on the result, visit the wall and the share page.
 * Waits on body[data-app-ready="1"], fails on any console error, saves
 * screenshots/<route>.png for desktop and phone.
 *
 *   node tools/screenshot.mjs [--no-build]
 */
import { spawn, execFileSync, execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const PORT = 6951
const KEY = "smoke-key-long-enough"
const ORIGIN = `http://127.0.0.1:${PORT}`
const H = { "x-rhapsode-key": KEY }

const noBuild = process.argv.includes("--no-build")
if (!noBuild) {
  console.log("building…")
  execSync("npm run build", { cwd: ROOT, stdio: "pipe" })
}
mkdirSync(join(ROOT, "screenshots"), { recursive: true })

const dataDir = mkdtempSync(join(tmpdir(), "rhapsode-smoke-"))
const fx = join(dataDir, "fx")
mkdirSync(fx)
const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args], { stdio: "pipe" })
ff(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=4", "-f", "lavfi", "-i", "sine=f=330:d=4", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-t", "4", `${fx}/base.mp4`])
ff(["-f", "lavfi", "-i", "testsrc=s=320x240:r=25:d=3", "-f", "lavfi", "-i", "sine=f=660:d=3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-t", "3", `${fx}/clip.mp4`])
ff(["-f", "lavfi", "-i", "color=c=0x2a1f5e:s=720x900", "-frames:v", "1", `${fx}/photo.png`])

const server = spawn("node", ["server/index.ts"], {
  cwd: ROOT,
  stdio: "pipe",
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, INVITE_KEY: KEY, PUBLIC_ORIGIN: ORIGIN, RATE_LIMIT: "0", RENDER_ENCODER: "libx264" },
})
let serverLog = ""
server.stderr.on("data", (d) => (serverLog += d))
server.stdout.on("data", (d) => (serverLog += d))

let failed = false
try {
  await waitFor(`${ORIGIN}/healthz`, 20000)

  // ————— seed through the real API —————
  const upload = async (file, name) => {
    const res = await fetch(`${ORIGIN}/api/sources`, {
      method: "POST",
      headers: { ...H, "content-type": "application/octet-stream", "x-filename": name },
      body: readFileSync(file),
    })
    if (res.status !== 202) throw new Error(`upload ${name}: ${res.status} ${await res.text()}`)
    const { source, job } = await res.json()
    const done = await waitJob(job.id)
    if (done.status !== "done") throw new Error(`fetch job for ${name} failed: ${done.error}`)
    return source
  }
  const base = await upload(`${fx}/base.mp4`, "smoke base.mp4")
  const clip = await upload(`${fx}/clip.mp4`, "smoke clip.mp4")
  await upload(`${fx}/photo.png`, "smoke photo.png")

  const renderRes = await fetch(`${ORIGIN}/api/renders`, {
    method: "POST",
    headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify({
      title: "seeded render",
      recipe: {
        v: 1,
        base: { kind: "video", source: base.id, in: 0.5, out: 3.5 },
        overlay: { source: clip.id, in: 0, out: 2, at: 0.5 },
        mode: { kind: "pip", box: { x: 0.55, y: 0.05, w: 0.4 } },
        captions: [{ text: "smoke test" }],
        output: { aspect: "9:16" },
      },
    }),
  })
  if (renderRes.status !== 202) throw new Error(`seed render: ${renderRes.status} ${await renderRes.text()}`)
  const seeded = await renderRes.json()
  const seededJob = await waitJob(seeded.job.id)
  if (seededJob.status !== "done") throw new Error(`seed render failed: ${seededJob.error}`)

  const browser = await chromium.launch()
  const errors = []

  // ————— desktop: the whole flow through the UI —————
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watch(page, errors)
  await page.goto(`${ORIGIN}/#/`, { waitUntil: "networkidle" })
  await page.waitForSelector('body[data-app-ready="1"]', { timeout: 10000 })
  await page.screenshot({ path: shot("compose-empty") })
  console.log("  ✓ compose (guest)")

  // unlock with the key through the real dialog
  await page.getByRole("button", { name: /guest/ }).click()
  await page.fill("input[type=password]", KEY)
  await page.getByRole("button", { name: "Unlock" }).click()
  await page.waitForSelector(".rh-recent__item", { timeout: 10000 })
  await page.screenshot({ path: shot("compose-keyed") })

  // pick the recent sources: base = the 4 s clip, overlay = the 3 s clip
  await page.locator(".rh-picker--base .rh-recent__item", { hasText: "smoke base" }).first().click()
  await page.locator(".rh-picker--overlay .rh-recent__item", { hasText: "smoke clip" }).first().click()
  await page.waitForSelector(".rh-stage", { timeout: 10000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: shot("compose-ready") })
  console.log("  ✓ compose (sources picked, stage up)")

  // picture-in-picture + a caption, then render from the UI
  await page.getByRole("button", { name: "picture-in-picture" }).click()
  await page.getByRole("button", { name: "+ caption" }).click()
  await page.fill("textarea.rh-textarea", "from the UI")
  await page.fill('input[placeholder="title (optional)"]', "ui render")
  await page.waitForTimeout(300)
  await page.screenshot({ path: shot("compose-pip") })
  await page.locator(".rh-renderbtn").click()
  await page.waitForURL(/#\/r\//, { timeout: 60000 })
  await page.waitForSelector("video", { timeout: 10000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: shot("result") })
  const slug = decodeURIComponent(page.url().split("#/r/")[1])
  console.log(`  ✓ rendered from the UI → ${slug}`)

  await page.goto(`${ORIGIN}/#/wall`, { waitUntil: "networkidle" })
  await page.waitForSelector('body[data-app-ready="1"]', { timeout: 10000 })
  await page.waitForSelector(".rh-wall__card, .rh-card, a[href*='#/r/']", { timeout: 10000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: shot("wall") })
  console.log("  ✓ wall")

  // share page is server-rendered — no app-ready marker
  await page.goto(`${ORIGIN}/m/${slug}`, { waitUntil: "networkidle" })
  const og = await page.locator('meta[property="og:video"]').getAttribute("content")
  if (!og || !og.endsWith(`/m/${slug}.mp4`)) throw new Error(`share page og:video wrong: ${og}`)
  await page.screenshot({ path: shot("share") })
  console.log("  ✓ share")

  // remix reopens the recipe (no networkidle here — the stage's videos keep streaming)
  await page.goto(`${ORIGIN}/#/remix/${slug}`, { waitUntil: "load" })
  await page.waitForSelector(".rh-stage", { timeout: 10000 })
  console.log("  ✓ remix")
  await page.close()

  // ————— phone —————
  const phoneCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  })
  await phoneCtx.addInitScript(([k]) => {
    localStorage.setItem("rhapsode:v1:auth", JSON.stringify({ state: { key: k, verified: true }, version: 0 }))
  }, [KEY])
  const phone = await phoneCtx.newPage()
  watch(phone, errors)

  for (const [name, path] of [["compose", "/#/"], ["wall", "/#/wall"], ["result", `/#/r/${slug}`]]) {
    await phone.goto(`${ORIGIN}${path}`, { waitUntil: "load" })
    await phone.waitForSelector('body[data-app-ready="1"]', { timeout: 10000 })
    await phone.waitForTimeout(400)
    // the tab bar must sit inside the viewport, above the home indicator
    const bar = await phone.locator(".rh-nav--bottom").boundingBox()
    if (!bar || bar.y + bar.height > 844 + 1) throw new Error(`phone ${name}: tab bar off-screen (${JSON.stringify(bar)})`)
    const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    if (wide) throw new Error(`phone ${name}: page scrolls horizontally`)
    await phone.screenshot({ path: shot(`phone-${name}`) })
    console.log(`  ✓ phone ${name}`)
  }
  // the stepper: pick pieces → cut → compose on a phone
  await phone.goto(`${ORIGIN}/#/`, { waitUntil: "load" })
  await phone.waitForSelector(".rh-recent__item", { timeout: 10000 })
  await phone.locator(".rh-picker--base .rh-recent__item", { hasText: "smoke photo" }).first().click()
  await phone.locator(".rh-picker--overlay .rh-recent__item", { hasText: "smoke clip" }).first().click()
  await phone.getByRole("button", { name: /next — cut/ }).click()
  await phone.waitForSelector(".rh-trimmer, .rh-field", { timeout: 10000 })
  await phone.screenshot({ path: shot("phone-cut") })
  await phone.getByRole("button", { name: /next — compose/ }).click()
  await phone.waitForSelector(".rh-stage", { timeout: 10000 })
  await phone.waitForTimeout(500)
  const stage = await phone.locator(".rh-stage").boundingBox()
  if (!stage || stage.x < -1 || stage.x + stage.width > 391) throw new Error(`phone stage overflows: ${JSON.stringify(stage)}`)
  await phone.screenshot({ path: shot("phone-compose-ready") })
  console.log("  ✓ phone stepper")
  await phoneCtx.close()
  await browser.close()

  if (errors.length) {
    console.error("console errors:\n  " + errors.join("\n  "))
    failed = true
  }
} catch (err) {
  console.error(err)
  console.error("--- server log ---\n" + serverLog.slice(-4000))
  failed = true
} finally {
  server.kill("SIGTERM")
  rmSync(dataDir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)

function shot(name) {
  return join(ROOT, "screenshots", `${name}.png`)
}

function watch(page, errors) {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[console] ${m.text()}`)
  })
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`))
}

async function waitJob(id) {
  for (let i = 0; i < 1200; i++) {
    const res = await fetch(`${ORIGIN}/api/jobs/${id}`, { headers: H })
    const job = await res.json()
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return job
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`job ${id} never finished`)
}

async function waitFor(url, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`server never answered at ${url}\n${serverLog.slice(-2000)}`)
}
