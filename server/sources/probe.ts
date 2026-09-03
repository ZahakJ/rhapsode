import { runProc } from "../proc.ts"

export type Probe = {
  media: "video" | "image"
  duration: number
  /** display dimensions (rotation applied) */
  width: number
  height: number
  fps: number
  hasAudio: boolean
  vcodec: string | null
  acodec: string | null
  rotation: number
  bytes: number
}

type Stream = {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  disposition?: { attached_pic?: number }
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>
  tags?: Record<string, string>
}

const IMAGE_FORMATS = new Set(["image2", "png_pipe", "jpeg_pipe", "webp_pipe", "gif", "image2pipe"])

export async function ffprobe(file: string, signal?: AbortSignal): Promise<Probe> {
  const { stdout } = await runProc(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { timeoutMs: 60_000, signal },
  )
  const json = JSON.parse(stdout) as { format?: Record<string, string>; streams?: Stream[] }
  const streams = json.streams ?? []
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic)
  const a = streams.find((s) => s.codec_type === "audio")
  if (!v || !v.width || !v.height) throw new Error("no decodable video or image stream")
  const formatName = json.format?.format_name ?? ""
  const isImage = formatName.split(",").some((f) => IMAGE_FORMATS.has(f)) || (!json.format?.duration && !a)
  const rotation = readRotation(v)
  const swap = Math.abs(rotation) % 180 === 90
  const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30
  return {
    media: isImage ? "image" : "video",
    duration: isImage ? 0 : Number(json.format?.duration ?? 0) || 0,
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    fps: isImage ? 0 : fps,
    hasAudio: !isImage && !!a,
    vcodec: v.codec_name ?? null,
    acodec: a?.codec_name ?? null,
    rotation,
    bytes: Number(json.format?.size ?? 0) || 0,
  }
}

function readRotation(v: Stream): number {
  for (const sd of v.side_data_list ?? []) {
    if (sd.side_data_type === "Display Matrix" && typeof sd.rotation === "number") return sd.rotation
  }
  const tag = Number(v.tags?.rotate)
  return Number.isFinite(tag) ? tag : 0
}

function parseRate(s: string | undefined): number {
  if (!s) return 0
  const [n, d] = s.split("/").map(Number)
  if (!n || !Number.isFinite(n)) return 0
  const r = d ? n / d : n
  return Number.isFinite(r) && r > 0 && r < 1000 ? r : 0
}
