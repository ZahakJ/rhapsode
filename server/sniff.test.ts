import { describe, expect, it } from "vitest"
import { sniff } from "./sniff.ts"

function bytes(...parts: (number[] | string)[]): Uint8Array {
  const out: number[] = []
  for (const p of parts) {
    if (typeof p === "string") for (const ch of p) out.push(ch.charCodeAt(0))
    else out.push(...p)
  }
  while (out.length < 16) out.push(0)
  return new Uint8Array(out)
}

describe("sniff", () => {
  it("detects png", () => {
    expect(sniff(bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a]))?.mime).toBe("image/png")
  })
  it("detects jpeg", () => {
    expect(sniff(bytes([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe("jpg")
  })
  it("detects gif", () => {
    expect(sniff(bytes("GIF89a"))?.mime).toBe("image/gif")
  })
  it("detects webp", () => {
    expect(sniff(bytes("RIFF", [1, 2, 3, 4], "WEBP"))?.mime).toBe("image/webp")
  })
  it("detects mp4 via ftyp", () => {
    expect(sniff(bytes([0, 0, 0, 0x18], "ftypisom"))).toEqual({
      mime: "video/mp4",
      ext: "mp4",
      kind: "video",
    })
  })
  it("accepts the other mp4 brands", () => {
    for (const brand of ["iso2", "mp41", "mp42", "avc1", "dash", "M4V "]) {
      expect(sniff(bytes([0, 0, 0, 0x18], `ftyp${brand}`))?.mime, brand).toBe("video/mp4")
    }
  })
  it("rejects non-mp4 ISO-BMFF brands instead of mislabelling them .mp4", () => {
    for (const brand of ["avif", "avis", "heic", "heix", "hevc", "mif1"]) {
      expect(sniff(bytes([0, 0, 0, 0x18], `ftyp${brand}`)), brand).toBeNull()
    }
  })
  it("detects webm/EBML", () => {
    expect(sniff(bytes([0x1a, 0x45, 0xdf, 0xa3]))?.mime).toBe("video/webm")
  })
  it("rejects svg and unknown bytes", () => {
    expect(sniff(bytes('<svg xmlns="http'))).toBeNull()
    expect(sniff(bytes("hello world, not"))).toBeNull()
  })
  it("rejects short buffers", () => {
    expect(sniff(new Uint8Array([0x89, 0x50]))).toBeNull()
  })
})

describe("sniff — transcodable containers", () => {
  it("accepts QuickTime and 3GP as inputs", () => {
    const mk = (brand: string) => {
      const b = new Uint8Array(16)
      b.set([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70], 0)
      for (let i = 0; i < 4; i++) b[8 + i] = brand.charCodeAt(i)
      return b
    }
    expect(sniff(mk("qt  "))?.ext).toBe("mov")
    expect(sniff(mk("3gp4"))?.ext).toBe("3gp")
  })
})
