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

function readPackage(dir: string): { version?: string; license?: unknown } {
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
    id: typeof pkg.license === "string" ? pkg.license : undefined,
    text: file ? readFileSync(path.join(root, file), "utf-8") : undefined,
  };
}

/** The notices file: the plugin's dependencies plus the fixed extra packages. */
export function renderNotices(
  dependencies: Iterable<NoticeEntry>,
  nodeModules?: string,
): string {
  const seen = new Set<string>();
  const all: NoticeEntry[] = Array.from(dependencies);
  for (const d of all) seen.add(d.name);
  for (const name of CSS_AND_FONT_PACKAGES) {
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
    "Third-party software bundled in the web console.",
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
