import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { DatabaseSync } from "node:sqlite"
import type { JobDto, JobKind, JobStatus, RenderDto, SourceDto, SourceKind, SourceMedia, SourceStatus } from "../shared/recipe.ts"
import { uniqueSlug } from "./slugs.ts"

export type SourceRow = {
  id: string
  kind: SourceKind
  media: SourceMedia
  status: SourceStatus
  url: string | null
  title: string
  ext: string
  duration: number | null
  width: number | null
  height: number | null
  fps: number | null
  has_audio: number
  window_start: number | null
  window_end: number | null
  sha256: string | null
  bytes: number
  error: string | null
  job_id: string | null
  created_at: number
  last_used_at: number
}

export type RenderRow = {
  id: number
  slug: string
  title: string
  recipe_json: string
  duration: number
  width: number
  height: number
  bytes: number
  job_id: string | null
  created_at: number
}

export type JobRow = {
  id: string
  kind: JobKind
  status: JobStatus
  stage: string | null
  progress: number | null
  error: string | null
  payload_json: string
  result_json: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

export const newId = (): string => crypto.randomBytes(12).toString("hex")

export class Store {
  readonly db: DatabaseSync
  readonly dataDir: string
  readonly sourcesDir: string
  readonly rendersDir: string
  readonly jobsDir: string
  readonly tmpDir: string
  private inflightSlugs = new Set<string>()

  constructor(db: DatabaseSync, dataDir: string) {
    this.db = db
    this.dataDir = dataDir
    this.sourcesDir = path.join(dataDir, "sources")
    this.rendersDir = path.join(dataDir, "renders")
    this.jobsDir = path.join(dataDir, "jobs")
    this.tmpDir = path.join(dataDir, "tmp")
    for (const d of [this.sourcesDir, this.rendersDir, this.jobsDir, this.tmpDir]) fs.mkdirSync(d, { recursive: true })
  }

  // ——— sources ———

  sourceDir(id: string): string {
    return path.join(this.sourcesDir, id)
  }
  sourceFile(id: string, name: string): string {
    return path.join(this.sourcesDir, id, name)
  }
  origPath(row: SourceRow): string {
    return this.sourceFile(row.id, `orig.${row.ext}`)
  }
  proxyName(row: SourceRow): string {
    return row.media === "image" ? "proxy.jpg" : row.media === "audio" ? "proxy.m4a" : "proxy.mp4"
  }

  insertSource(s: {
    id: string
    kind: SourceKind
    media: SourceMedia
    url?: string | null
    title?: string
    ext?: string
    duration?: number | null
    windowStart?: number | null
    windowEnd?: number | null
    sha256?: string | null
    bytes?: number
    jobId?: string | null
  }): SourceRow {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO sources (id, kind, media, status, url, title, ext, duration, window_start, window_end, sha256, bytes, job_id, created_at, last_used_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id, s.kind, s.media, s.url ?? null, s.title ?? "", s.ext ?? "", s.duration ?? null,
        s.windowStart ?? null, s.windowEnd ?? null, s.sha256 ?? null, s.bytes ?? 0, s.jobId ?? null, now, now,
      )
    return this.sourceById(s.id)!
  }

  sourceById(id: string): SourceRow | null {
    return (this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow | undefined) ?? null
  }

  readySourceBySha(sha: string): SourceRow | null {
    return (
      (this.db.prepare("SELECT * FROM sources WHERE sha256 = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1").get(sha) as
        | SourceRow
        | undefined) ?? null
    )
  }

  updateSource(id: string, patch: Partial<Omit<SourceRow, "id">>): void {
    const keys = Object.keys(patch) as Array<keyof typeof patch>
    if (keys.length === 0) return
    const sets = keys.map((k) => `${k} = ?`).join(", ")
    this.db.prepare(`UPDATE sources SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k] as never), id)
  }

  touchSources(ids: string[]): void {
    const stmt = this.db.prepare("UPDATE sources SET last_used_at = ? WHERE id = ?")
    for (const id of ids) stmt.run(Date.now(), id)
  }

  listReadySources(limit = 50): SourceRow[] {
    return this.db.prepare("SELECT * FROM sources WHERE status = 'ready' ORDER BY last_used_at DESC LIMIT ?").all(limit) as SourceRow[]
  }

  sourceRenderCount(id: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM render_sources WHERE source_id = ?").get(id) as { n: number }
    return r.n
  }

  deleteSource(id: string): void {
    this.db.prepare("DELETE FROM sources WHERE id = ?").run(id)
    fs.rmSync(this.sourceDir(id), { recursive: true, force: true })
  }

  /** sources nobody references, untouched for longer than ttl */
  staleSources(olderThanMs: number): SourceRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM sources s
         WHERE s.status IN ('ready','failed') AND s.last_used_at < ?
           AND NOT EXISTS (SELECT 1 FROM render_sources rs WHERE rs.source_id = s.id)
         ORDER BY s.last_used_at ASC`,
      )
      .all(Date.now() - olderThanMs) as SourceRow[]
  }

  unreferencedSourcesOldestFirst(): SourceRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM sources s
         WHERE s.status IN ('ready','failed')
           AND NOT EXISTS (SELECT 1 FROM render_sources rs WHERE rs.source_id = s.id)
         ORDER BY s.last_used_at ASC`,
      )
      .all() as SourceRow[]
  }

  storageStats(): {
    sources: { count: number; bytes: number; unreferenced: number; unreferencedBytes: number }
    renders: { count: number; bytes: number }
    jobs: { active: number }
  } {
    const src = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM sources").get() as { n: number; b: number }
    const un = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM sources s
         WHERE NOT EXISTS (SELECT 1 FROM render_sources rs WHERE rs.source_id = s.id)`,
      )
      .get() as { n: number; b: number }
    const ren = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM renders").get() as { n: number; b: number }
    const act = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get() as { n: number }
    return {
      sources: { count: src.n, bytes: src.b, unreferenced: un.n, unreferencedBytes: un.b },
      renders: { count: ren.n, bytes: ren.b },
      jobs: { active: act.n },
    }
  }

  renderBytes(): number {
    const b = this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM renders").get() as { n: number }
    return b.n
  }

  totalBytes(): number {
    const a = this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM sources").get() as { n: number }
    const b = this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM renders").get() as { n: number }
    return a.n + b.n
  }

  sourceDto(row: SourceRow): SourceDto {
    const ready = row.status === "ready"
    return {
      id: row.id,
      kind: row.kind,
      media: row.media,
      status: row.status,
      title: row.title,
      url: row.url,
      duration: row.duration,
      width: row.width,
      height: row.height,
      fps: row.fps,
      hasAudio: row.has_audio === 1,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      error: row.error,
      jobId: row.job_id,
      proxyUrl: ready ? `/s/${row.id}/${this.proxyName(row)}` : null,
      thumbUrl: ready ? `/s/${row.id}/thumb.jpg` : null,
      createdAt: row.created_at,
    }
  }

  // ——— renders ———

  renderPath(slug: string, ext: "mp4" | "jpg"): string {
    return path.join(this.rendersDir, `${slug}.${ext}`)
  }

  reserveSlug(): string {
    const slug = uniqueSlug((s) => this.inflightSlugs.has(s) || this.renderBySlug(s) !== null)
    this.inflightSlugs.add(slug)
    return slug
  }
  releaseSlug(slug: string): void {
    this.inflightSlugs.delete(slug)
  }

  insertRender(r: {
    slug: string
    title: string
    recipeJson: string
    duration: number
    width: number
    height: number
    bytes: number
    jobId: string | null
    sourceIds: string[]
  }): RenderRow {
    const now = Date.now()
    this.db.exec("BEGIN")
    try {
      const res = this.db
        .prepare(
          `INSERT INTO renders (slug, title, recipe_json, duration, width, height, bytes, job_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.slug, r.title, r.recipeJson, r.duration, r.width, r.height, r.bytes, r.jobId, now)
      const id = Number(res.lastInsertRowid)
      const link = this.db.prepare("INSERT OR IGNORE INTO render_sources (render_id, source_id) VALUES (?, ?)")
      for (const sid of new Set(r.sourceIds)) link.run(id, sid)
      this.db.exec("COMMIT")
    } catch (e) {
      this.db.exec("ROLLBACK")
      throw e
    }
    this.inflightSlugs.delete(r.slug)
    return this.renderBySlug(r.slug)!
  }

  renderBySlug(slug: string): RenderRow | null {
    return (this.db.prepare("SELECT * FROM renders WHERE slug = ?").get(slug) as RenderRow | undefined) ?? null
  }

  listRenders(cursor: string | null, limit: number): { rows: RenderRow[]; nextCursor: string | null } {
    let rows: RenderRow[]
    if (cursor) {
      const [ts, id] = cursor.split(".").map(Number)
      rows = this.db
        .prepare(
          "SELECT * FROM renders WHERE (created_at < ?) OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .all(ts ?? 0, ts ?? 0, id ?? 0, limit + 1) as RenderRow[]
    } else {
      rows = this.db.prepare("SELECT * FROM renders ORDER BY created_at DESC, id DESC LIMIT ?").all(limit + 1) as RenderRow[]
    }
    let nextCursor: string | null = null
    if (rows.length > limit) {
      rows = rows.slice(0, limit)
      const last = rows.at(-1)!
      nextCursor = `${last.created_at}.${last.id}`
    }
    return { rows, nextCursor }
  }

  renderSourceIds(renderId: number): string[] {
    return (this.db.prepare("SELECT source_id FROM render_sources WHERE render_id = ?").all(renderId) as Array<{ source_id: string }>).map(
      (r) => r.source_id,
    )
  }

  deleteRender(slug: string): boolean {
    const row = this.renderBySlug(slug)
    if (!row) return false
    this.db.prepare("DELETE FROM renders WHERE id = ?").run(row.id)
    fs.rmSync(this.renderPath(slug, "mp4"), { force: true })
    fs.rmSync(this.renderPath(slug, "jpg"), { force: true })
    return true
  }

  renderDto(row: RenderRow): RenderDto {
    return {
      slug: row.slug,
      title: row.title,
      duration: row.duration,
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      url: `/m/${row.slug}.mp4`,
      posterUrl: `/m/${row.slug}.jpg`,
      shareUrl: `/m/${row.slug}`,
      createdAt: row.created_at,
    }
  }

  // ——— jobs ———

  jobDir(id: string): string {
    return path.join(this.jobsDir, id)
  }

  insertJob(kind: JobKind, payload: unknown): JobRow {
    const id = newId()
    this.db
      .prepare("INSERT INTO jobs (id, kind, status, payload_json, created_at) VALUES (?, ?, 'queued', ?, ?)")
      .run(id, kind, JSON.stringify(payload), Date.now())
    return this.jobById(id)!
  }

  jobById(id: string): JobRow | null {
    return (this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined) ?? null
  }

  updateJob(id: string, patch: Partial<Omit<JobRow, "id">>): void {
    const keys = Object.keys(patch) as Array<keyof typeof patch>
    if (keys.length === 0) return
    const sets = keys.map((k) => `${k} = ?`).join(", ")
    this.db.prepare(`UPDATE jobs SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k] as never), id)
  }

  /** anything that was mid-flight when the process died */
  failStaleJobs(reason: string): JobRow[] {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued','running')").all() as JobRow[]
    const now = Date.now()
    for (const j of rows) this.updateJob(j.id, { status: "failed", error: reason, finished_at: now })
    return rows
  }

  activeJobs(): JobRow[] {
    return this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued','running')").all() as JobRow[]
  }

  deleteOldJobs(olderThanMs: number): number {
    const r = this.db
      .prepare("DELETE FROM jobs WHERE status IN ('done','failed','cancelled') AND created_at < ?")
      .run(Date.now() - olderThanMs)
    return Number(r.changes)
  }

  jobDto(row: JobRow): JobDto {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      stage: row.stage,
      progress: row.progress,
      error: row.error,
      result: row.result_json ? (JSON.parse(row.result_json) as unknown) : null,
      createdAt: row.created_at,
    }
  }
}
