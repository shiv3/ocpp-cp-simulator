import path from "path";
import { defineConfig } from "vitest/config";

// Spike-only config: run from the repo root with
//   npx vitest run --config apps/web/spikes/ui-sdk-combobox/vitest.config.ts
// after `npm install` in this directory. The root config excludes
// `apps/web/spikes/**`, so `bun run test` never needs the spike's install.
const root = path.resolve(__dirname, "../../../..");
export default defineConfig({
  root,
  test: {
    environment: "jsdom",
    include: ["apps/web/spikes/ui-sdk-combobox/**/*.spike.test.tsx"],
    setupFiles: [
      "apps/web/src/test/setup.dom.ts",
      "apps/web/spikes/ui-sdk-combobox/setup.spike.ts",
    ],
  },
  resolve: {
    alias: { "@": path.resolve(root, "apps/web/src") },
    dedupe: ["react", "react-dom"],
  },
});
