import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_URL || "./",
  test: {
    environment: "node",
    // bun:sqlite is a runtime built-in that vite can't resolve. Tests
    // ending in `.bun.test.ts` run under `bun test` instead (see the
    // `test:bun` npm script); skip them here.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.bun.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
