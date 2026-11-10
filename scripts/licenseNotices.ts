import path from "path";
import { existsSync, readdirSync, readFileSync } from "fs";

// Helpers of the vite license plugin (vite.config.ts, #857).

/**
 * Packages whose files ship in the web console build without passing through
 * the JS module graph, so rollup-plugin-license never sees them: the bundled
 * IBM Plex fonts (OFL-1.1 requires its copyright notice and license text with
 * every redistributed copy) and the CSS-only Tailwind packages.
 */
export const CSS_AND_FONT_PACKAGES = [
  "@fontsource/ibm-plex-sans",
  "@fontsource/ibm-plex-mono",
  "tailwindcss",
  "flowbite",
  "tailwindcss-animate",
] as const;

export interface NoticeEntry {
  name: string;
  version: string;
  license?: string | null;
  licenseText?: string | null;
  repository?: string | { url?: string } | null;
  author?: string | null;
}

/** The SPDX-ish id of a package.json: `license`, `{type}` or legacy `licenses[]`. */
function licenseId(pkg: {
  license?: unknown;
  licenses?: unknown;
}): string | undefined {
  const one = (l: unknown): string | undefined =>
    typeof l === "string" ? l : (l as { type?: string } | undefined)?.type;
  if (pkg.license) return one(pkg.license);
  if (Array.isArray(pkg.licenses)) {
    const ids = pkg.licenses.map(one).filter((x): x is string => !!x);
    if (ids.length) return ids.join(" OR ");
  }
  return undefined;
}

/**
 * Packages that publish no license file or field to npm, so the notice text
 * would be empty. The text is the repository's own LICENSE.
 */
const FALLBACK_LICENSES: Record<
  string,
  { license: string; licenseText: string }
> = {
  "mcp-lite": {
    license: "MIT",
    // https://github.com/fiberplane/mcp-lite/blob/main/LICENSE
    licenseText:
      'MIT License\n\nCopyright (c) 2025 Fiberplane\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.',
  },
};

function readPackage(dir: string): {
  version?: string;
  license?: unknown;
  licenses?: unknown;
} {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"));
}

/** The directory of `name@version`: the hoisted copy, else a nested one. */
function packageDir(
  name: string,
  version: string | undefined,
  nodeModules: string,
): string | undefined {
  const matches = (dir: string) =>
    existsSync(path.join(dir, "package.json")) &&
    (!version || readPackage(dir).version === version);
  const hoisted = path.join(nodeModules, name);
  if (matches(hoisted)) return hoisted;
  for (const parent of readdirSync(nodeModules)) {
    const nested = path.join(nodeModules, parent, "node_modules", name);
    if (matches(nested)) return nested;
  }
  return undefined;
}

/**
 * The license plugin takes the nearest package.json of a bundled module, which
 * for a package that ships a nested `{"type":"module"}` file (socket.io-client's
 * build/esm) is not the package's own, so its text and SPDX id come back empty.
 * Read both from the package directory of that exact version (a nested copy of
 * the same name must not get the hoisted one's text).
 */
export function packageLicense(
  name: string,
  version?: string,
  nodeModules = path.resolve(__dirname, "..", "node_modules"),
): { id?: string; text?: string } {
  const root = packageDir(name, version, nodeModules);
  if (!root) return {};
  const file = readdirSync(root).find((f) => /^licen[sc]e(\.\w+)?$/i.test(f));
  const pkg = readPackage(root);
  return {
    id: licenseId(pkg) ?? FALLBACK_LICENSES[name]?.license,
    text: file
      ? readFileSync(path.join(root, file), "utf-8")
      : FALLBACK_LICENSES[name]?.licenseText,
  };
}

/** The notices file: the plugin's dependencies plus the fixed extra packages. */
export function renderNotices(
  dependencies: Iterable<NoticeEntry>,
  nodeModules?: string,
  options: { title?: string; assetPackages?: readonly string[] } = {},
): string {
  const seen = new Set<string>();
  const all: NoticeEntry[] = Array.from(dependencies);
  for (const d of all) seen.add(d.name);
  for (const name of options.assetPackages ?? CSS_AND_FONT_PACKAGES) {
    if (seen.has(name)) continue;
    const dir = packageDir(
      name,
      undefined,
      nodeModules ?? path.resolve(__dirname, "..", "node_modules"),
    );
    if (!dir) throw new Error(`notices: ${name} is not installed`);
    all.push({ name, version: readPackage(dir).version ?? "" });
  }
  return [
    options.title ?? "Third-party software bundled in the web console.",
    "",
    ...all
      .sort((a, b) =>
        `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
      )
      .map((d) => {
        const own = d.licenseText
          ? {}
          : packageLicense(d.name, d.version, nodeModules);
        const repo =
          typeof d.repository === "string" ? d.repository : d.repository?.url;
        return [
          "=".repeat(78),
          `${d.name}@${d.version}`,
          `License: ${d.license ?? own.id ?? "UNKNOWN"}`,
          ...(repo ? [`Repository: ${repo}`] : []),
          "",
          d.licenseText?.trim() ||
            own.text?.trim() ||
            `(no license file in the package; copyright: ${d.author ?? "see the package"})`,
          "",
        ].join("\n");
      }),
  ].join("\n");
}

/**
 * The npm packages a `bun build --metafile` run inlined into a bundle (#870).
 * `inputs` are the metafile's input paths (relative to `root`); the package of
 * an input is the one under its LAST `node_modules/`, so a nested copy
 * (`node_modules/a/node_modules/b/x.js`) is `b`, not `a`. The workspace's own
 * packages are ours, not third-party, and are left out.
 */
export function bundledPackages(
  inputs: Iterable<string>,
  root: string,
  ownScope = "@ocpp-cp-simulator/",
): NoticeEntry[] {
  const found = new Map<string, NoticeEntry>();
  for (const input of Array.from(inputs)) {
    const normalized = input.replace(/\\/g, "/");
    const at = normalized.lastIndexOf("node_modules/");
    if (at === -1) continue;
    const parts = normalized.slice(at + "node_modules/".length).split("/");
    const name = parts[0]?.startsWith("@")
      ? parts.slice(0, 2).join("/")
      : parts[0];
    if (!name || name.startsWith(ownScope)) continue;
    const dir = path.join(root, normalized.slice(0, at), "node_modules", name);
    if (!existsSync(path.join(dir, "package.json"))) continue;
    const pkg = readPackage(dir) as {
      version?: string;
      license?: unknown;
      licenses?: unknown;
      repository?: string | { url?: string };
      author?: unknown;
    };
    const key = `${name}@${pkg.version ?? ""}`;
    if (found.has(key)) continue;
    found.set(key, {
      name,
      version: pkg.version ?? "",
      license: licenseId(pkg) ?? FALLBACK_LICENSES[name]?.license,
      repository: pkg.repository,
      author:
        typeof pkg.author === "string"
          ? pkg.author
          : ((pkg.author as { name?: string } | undefined)?.name ?? undefined),
    });
  }
  return Array.from(found.values());
}
