import type {
  JobDto,
  RecipeInput,
  Recipe,
  RenderDto,
  RenderPage,
  SourceDto,
  StorageDto,
} from "../../shared/recipe.ts"
import { useAuth } from "../store/authStore.ts"

export class ApiError extends Error {
  status: number
  body: Record<string, unknown>
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = useAuth.getState().key
  const headers = new Headers(init.headers)
  if (key) headers.set("x-rhapsode-key", key)
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    let msg = res.statusText
    let body: Record<string, unknown> = {}
    try {
      body = (await res.json()) as Record<string, unknown>
      if (typeof body.error === "string") msg = body.error
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, msg, body)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

export type SourceCreated = { source: SourceDto; job: JobDto | null }
export type RenderCreated = { job: JobDto; slug: string }
export type RecipeBundle = { recipe: Recipe; sources: SourceDto[] }

export const api = {
  verifyKey: async (key: string): Promise<boolean> => {
    const res = await fetch("/api/verify-key", {
      method: "POST",
      headers: { "x-rhapsode-key": key },
    })
    return res.ok
  },

  // ——— sources ———
  createUrlSource: (url: string, around?: number) =>
    request<SourceCreated>("/api/sources", json(around === undefined ? { url } : { url, around })),

  getSource: (id: string) => request<SourceDto>(`/api/sources/${encodeURIComponent(id)}`),
  listSources: () => request<SourceDto[]>("/api/sources"),
  deleteSource: (id: string) =>
    request<void>(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /**
   * Raw-body upload with progress — fetch has no upload progress, so this is
   * the one XMLHttpRequest in the app.
   */
  uploadSource: (
    file: File,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<SourceCreated> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open("POST", "/api/sources")
      xhr.setRequestHeader("content-type", "application/octet-stream")
      // header values must be ISO-8859-1; the name is display-only anyway
      xhr.setRequestHeader("x-filename", encodeURIComponent(file.name).slice(0, 200))
      const key = useAuth.getState().key
      if (key) xhr.setRequestHeader("x-rhapsode-key", key)
      xhr.responseType = "json"
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total)
      }
      xhr.onload = () => {
        const body = (xhr.response ?? {}) as Record<string, unknown>
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as unknown as SourceCreated)
        else
          reject(
            new ApiError(
              xhr.status,
              typeof body.error === "string" ? body.error : xhr.statusText || "upload failed",
              body,
            ),
          )
      }
      xhr.onerror = () => reject(new ApiError(0, "network error during upload"))
      xhr.onabort = () => reject(new ApiError(0, "upload cancelled"))
      signal?.addEventListener("abort", () => xhr.abort())
      xhr.send(file)
    }),

  // ——— renders ———
  createRender: (recipe: RecipeInput, title?: string) =>
    request<RenderCreated>("/api/renders", json(title ? { recipe, title } : { recipe })),

  listRenders: (cursor?: string, limit = 30) => {
    const qs = new URLSearchParams()
    if (cursor) qs.set("cursor", cursor)
    qs.set("limit", String(limit))
    return request<RenderPage>(`/api/renders?${qs}`)
  },
  getRender: (slug: string) => request<RenderDto>(`/api/renders/${encodeURIComponent(slug)}`),
  getRecipe: (slug: string) =>
    request<RecipeBundle>(`/api/renders/${encodeURIComponent(slug)}/recipe`),
  deleteRender: (slug: string) =>
    request<void>(`/api/renders/${encodeURIComponent(slug)}`, { method: "DELETE" }),

  // ——— storage ———
  getStorage: () => request<StorageDto>("/api/storage"),
  sweepStorage: () => request<{ freedBytes: number; storage: StorageDto }>("/api/storage/sweep", { method: "POST" }),

  // ——— jobs ———
  getJob: (id: string) => request<JobDto>(`/api/jobs/${encodeURIComponent(id)}`),
  cancelJob: (id: string) => request<void>(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
}
