import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    exclude: ["tests/browser/baseline.test.mjs", "node_modules/**"],
    maxWorkers: 2,
    setupFiles: ["./tests/setup.ts"],
  },
});
