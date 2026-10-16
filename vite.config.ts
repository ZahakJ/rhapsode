/// <reference types="vitest/config" />
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Dev API server sits on 5950 (prod runs on 8013 so the live site keeps
// serving while you develop). Vite dev 5951, preview/smoke 6951 — family scheme.
const API = "http://127.0.0.1:5950"

export default defineConfig({
  root: "client",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5951,
    strictPort: true,
    // anchored, and never for a source module: a bare "/m" prefix would
    // swallow /main.tsx and "/api" the client's own api/*.ts
    proxy: {
      "^/api(/|$)": { target: API, bypass: (req) => (/\.tsx?(\?|$)/.test(req.url ?? "") ? req.url : undefined) },
      "^/m(/|$)": API,
      "^/s(/|$)": API,
      "/healthz": API,
    },
  },
  preview: { port: 6951, strictPort: true },
  test: {
    environment: "node",
    testTimeout: 60_000,
    include: ["../server/**/*.test.ts", "../shared/**/*.test.ts", "../client/**/*.test.ts", "../cut/**/*.test.ts"],
  },
})
