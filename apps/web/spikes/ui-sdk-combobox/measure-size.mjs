// Run from the repo root: node apps/web/spikes/ui-sdk-combobox/measure-size.mjs
import { build } from "vite";
import { gzipSync } from "node:zlib";
const root = process.cwd();
for (const [name, entry] of [
  ["production Combobox", "apps/web/src/console/components/Combobox.tsx"],
  [
    "UI SDK Autocomplete spike",
    "apps/web/spikes/ui-sdk-combobox/UiSdkCombobox.tsx",
  ],
]) {
  const r = await build({
    root,
    configFile: false,
    logLevel: "error",
    resolve: { alias: { "@": `${root}/apps/web/src` } },
    esbuild: { jsx: "automatic" },
    oxc: { jsx: { runtime: "automatic" } },
    build: {
      write: false,
      minify: true,
      lib: { entry: `${root}/${entry}`, formats: ["es"], fileName: "x" },
      rollupOptions: {
        external: [
          /^react(-dom|-i18next)?(\/.*)?$/,
          /lucide-react/,
          /lib\/utils/,
          /tailwind-merge|clsx/,
        ],
      },
    },
  });
  const out = (Array.isArray(r) ? r[0] : r).output.find(
    (o) => o.type === "chunk",
  );
  const code = Buffer.from(out.code);
  console.log(name, "min bytes", code.length, "gzip", gzipSync(code).length);
}
