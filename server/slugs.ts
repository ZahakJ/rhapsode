import { ADJECTIVES, NOUNS } from "../shared/slugWords.ts"

export function makeSlug(rand: () => number = Math.random): string {
  const a = ADJECTIVES[Math.floor(rand() * ADJECTIVES.length)]!
  const n = NOUNS[Math.floor(rand() * NOUNS.length)]!
  return `${a}-${n}`
}

/** Generate a slug not currently taken; falls back to a random suffix. */
export function uniqueSlug(
  taken: (slug: string) => boolean,
  rand: () => number = Math.random,
): string {
  for (let i = 0; i < 8; i++) {
    const slug = makeSlug(rand)
    if (!taken(slug)) return slug
  }
  for (;;) {
    const slug = `${makeSlug(rand)}-${Math.floor(rand() * 1296)
      .toString(36)
      .padStart(2, "0")}`
    if (!taken(slug)) return slug
  }
}

export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
}
