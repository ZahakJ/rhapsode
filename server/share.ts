import type { RenderDto } from "../shared/recipe.ts"

// Minimal server-rendered share page: OG/Twitter tags so links unfurl in
// WhatsApp/Telegram/Discord/iMessage, plus a dark page playing the render.
// No inline scripts (CSP script-src 'self').

export function renderSharePage(r: RenderDto, origin: string): string {
  const title = esc(r.title || r.slug)
  const videoUrl = `${origin}${r.url}`
  const posterUrl = `${origin}${r.posterUrl}`
  const shareUrl = `${origin}${r.shareUrl}`
  const secs = Math.round(r.duration)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${title} · rhapsode</title>
<meta property="og:title" content="${title}">
<meta property="og:site_name" content="rhapsode">
<meta property="og:url" content="${shareUrl}">
<meta property="og:type" content="video.other">
<meta property="og:video" content="${videoUrl}">
<meta property="og:video:secure_url" content="${videoUrl}">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="${r.width}">
<meta property="og:video:height" content="${r.height}">
<meta property="og:image" content="${posterUrl}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="${r.width}">
<meta property="og:image:height" content="${r.height}">
<meta property="video:duration" content="${secs}">
<meta name="twitter:card" content="player">
<meta name="twitter:title" content="${title}">
<meta name="twitter:image" content="${posterUrl}">
<meta name="twitter:player:stream" content="${videoUrl}">
<meta name="twitter:player:stream:content_type" content="video/mp4">
<style>
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:16px;background:#07060a;color:#f1ebe6;
    font-family:system-ui,sans-serif;padding:24px;box-sizing:border-box}
  video{max-width:min(92vw,960px);max-height:80vh;border-radius:8px;
    box-shadow:0 16px 48px rgba(0,0,0,.55);background:#000}
  a{color:#ff7a59;text-decoration:none;font-size:14px;letter-spacing:.12em;
    text-transform:uppercase}
  a:hover{text-decoration:underline}
  p{margin:0;color:#a89e97;font-size:15px}
  .row{display:flex;gap:20px;flex-wrap:wrap;justify-content:center}
</style>
</head>
<body>
<video src="${esc(r.url)}" poster="${esc(r.posterUrl)}" controls autoplay loop playsinline></video>
<p>${title}</p>
<div class="row">
<a href="${esc(r.url)}" download="${esc(r.slug)}.mp4">download</a>
<a href="/#/r/${esc(r.slug)}">open in rhapsode</a>
<a href="/#/wall">the wall</a>
</div>
</body>
</html>`
}

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}
