import { createInterface } from "node:readline"
import { z } from "zod"
import { runOp, schemas, type OpName } from "./ops.ts"

// MCP over stdio (newline-delimited JSON-RPC 2.0), local only: no network
// listener. Each tool is one cut op; the result is the manifest — file paths,
// times and hashes — as text and as structuredContent.

const TOOLS: Array<{ name: string; op: OpName; description: string }> = [
  { name: "probe", op: "probe", description: "Facts about a video URL (title, uploader, duration, what is cached) or a local file (size, fps, codec, colour). Does not download." },
  { name: "fetch", op: "fetch", description: "Download a URL (optionally only from..to) into the local cache and return the cached file. Later ops on the same URL reuse it." },
  { name: "list_scenes", op: "scenes", description: "Scene-change detection over a window; returns cut times with scores and, unless extract=false, one full-resolution frame per scene." },
  { name: "frames", op: "frames", description: "Single frames at exact timestamps (first frame at or after each time), optionally cropped/scaled." },
  { name: "strip", op: "strip", description: "Fixed-interval frame strip over a window, e.g. every 67ms from 12 to 14 s, for animation analysis. sheet=true adds a labelled contact sheet." },
  { name: "clip", op: "clip", description: "Cut video clips by time range. Stream copy when the cut starts on a keyframe, else re-encode (NVENC when available)." },
  { name: "contact_sheet", op: "sheet", description: "Tile frames from an earlier manifest (or image paths) into labelled contact sheets." },
]

function inputSchema(op: OpName) {
  const { $schema: _, ...rest } = z.toJSONSchema(schemas[op], { io: "input" }) as Record<string, unknown>
  return rest
}

type Req = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: Record<string, unknown> }

export function serveMcp(): Promise<void> {
  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`)
  const reply = (id: Req["id"], result: unknown) => send({ jsonrpc: "2.0", id, result })
  const fail = (id: Req["id"], code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } })

  async function handle(req: Req) {
    const { id, method, params } = req
    const isCall = id !== undefined && id !== null
    switch (method) {
      case "initialize":
        return reply(id, {
          protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "rhapsode-cut", version: "0.1.0" },
          instructions:
            "Video cutting for reference work. src is a URL (fetched once with yt-dlp, cached; only the needed section) or a local path. Times accept seconds or 1:02.5. Every result is a manifest: outputs[].path are files on this machine (read them with your image tools), with source and actual frame times and sha256.",
        })
      case "ping":
        return reply(id, {})
      case "tools/list":
        return reply(id, {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t.op) })),
        })
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params?.name)
        if (!tool) return fail(id, -32602, `unknown tool: ${String(params?.name)}`)
        try {
          const m = await runOp(tool.op, params?.arguments ?? {})
          return reply(id, {
            content: [{ type: "text", text: JSON.stringify(m, null, 1) }],
            structuredContent: m,
          })
        } catch (err) {
          return reply(id, { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true })
        }
      }
      default:
        if (method.startsWith("notifications/") || !isCall) return
        return fail(id, -32601, `method not found: ${method}`)
    }
  }

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
    const inflight = new Set<Promise<unknown>>()
    rl.on("line", (line) => {
      if (!line.trim()) return
      let req: Req
      try {
        req = JSON.parse(line) as Req
      } catch {
        return fail(null, -32700, "parse error")
      }
      const p = handle(req).then(() => undefined, (err) => { fail(req.id ?? null, -32603, String(err)) })
      inflight.add(p)
      void p.finally(() => inflight.delete(p))
    })
    rl.on("close", () => void Promise.all(inflight).then(() => resolve()))
  })
}
