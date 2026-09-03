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
    proxy: {
      "/api": API,
      "/m": API,
      "/s": API,
      "/healthz": API,
    },
  },
  preview: { port: 6951, strictPort: true },
  test: {
    environment: "node",
    testTimeout: 60_000,
    include: ["../server/**/*.test.ts", "../shared/**/*.test.ts", "../client/**/*.test.ts"],
  },
})
