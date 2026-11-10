import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { bundledPackages, renderNotices } from "./licenseNotices";

// `bun build` writes no license listing, so the CLI bundle (dist-cli/main.js,
// the Docker image, the Tauri sidecar) shipped the code of socket.io, ws, ...
// without the notices their MIT / ISC licenses ask for (#870). This reads the
// build's metafile, finds the npm packages it inlined and writes their notices.
// (`ws` is not among them: with `--target=bun` the bundle uses Bun's own.)
//
//   bun build ... --metafile=<meta.json> ... && \
//     bun run scripts/generate-cli-notices.ts <meta.json> [out]
const [metafile, out = "dist-cli/THIRD-PARTY-LICENSES.txt"] =
  process.argv.slice(2);
if (!metafile) {
  console.error("usage: generate-cli-notices.ts <metafile.json> [out]");
  process.exit(2);
}

const root = process.cwd();
const meta = JSON.parse(readFileSync(metafile, "utf-8")) as {
  inputs?: Record<string, unknown>;
};
const packages = bundledPackages(Object.keys(meta.inputs ?? {}), root);
if (packages.length === 0) {
  // An empty list means the metafile was not the bundle's, never a clean bundle.
  console.error(`notices: no node_modules package found in ${metafile}`);
  process.exit(1);
}
writeFileSync(
  path.resolve(root, out),
  renderNotices(packages, path.join(root, "node_modules"), {
    title: "Third-party software bundled in the CLI (dist-cli/main.js).",
    assetPackages: [],
  }),
);
console.log(`notices: ${packages.length} packages -> ${out}`);
