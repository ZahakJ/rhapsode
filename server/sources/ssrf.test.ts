import { describe, expect, it } from "vitest"
import { assertPublicHost, isPrivate, parseSourceUrl } from "./ssrf.ts"

describe("ssrf guard", () => {
  it("accepts public URLs", () => {
    expect(parseSourceUrl("https://www.youtube.com/watch?v=abc").hostname).toBe("www.youtube.com")
  })
  for (const bad of [
    "file:///etc/passwd",
    "ftp://x.com/a",
    "http://localhost/",
    "http://127.0.0.1:8000/",
    "http://[::1]/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest",
    "http://100.64.0.1/",
    "http://user:pw@youtube.com/",
    "http://foo.internal/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "not a url",
  ]) {
    it(`rejects ${bad}`, () => {
      expect(() => parseSourceUrl(bad)).toThrow()
    })
  }
  it("classifies addresses", () => {
    expect(isPrivate("8.8.8.8")).toBe(false)
    expect(isPrivate("2606:4700::1111")).toBe(false)
    expect(isPrivate("::1")).toBe(true)
    expect(isPrivate("::")).toBe(true)
    expect(isPrivate("64:ff9b::7f00:1")).toBe(true)
    expect(isPrivate("64:ff9b::808:808")).toBe(false)
  })
  it("rejects names resolving to private space", async () => {
    const u = parseSourceUrl("http://evil.example/")
    await expect(assertPublicHost(u, (async () => [{ address: "10.1.1.1", family: 4 }]) as never)).rejects.toThrow()
    await expect(assertPublicHost(u, (async () => [{ address: "1.1.1.1", family: 4 }]) as never)).resolves.toBeUndefined()
    await expect(assertPublicHost(u, (async () => { throw new Error("ENOTFOUND") }) as never)).rejects.toThrow()
  })
})
