// scripts/check-file-size.ts
//
// Line ratchet for non-test source files (#877). ESLint `max-lines` caps every
// file under packages/ and apps/ at MAX_LINES, and caps each file listed in
// scripts/file-size-allowlist.json at the size recorded there, so a file that
// is over the limit today may not grow. This check also fails on:
//
//   (a) an entry that names a file that does not exist,
//   (b) a file over MAX_LINES that has no entry,
//   (c) a file larger than its entry (growth).
//
// An entry that is larger than the file (slack), or still present for a file
// now at or under MAX_LINES, is only a warning, so a PR that shrinks a file
// does not have to touch the allowlist:
//   slack: <file> entry N > actual M; run --update to tighten
//
//   bun run scripts/check-file-size.ts            # exit 1 on any failure
//   bun run scripts/check-file-size.ts --update   # lower entries to the actual
//                                                 # size, drop the ones that fit;
//                                                 # never raises an entry
//
// Lines are counted like `wc -l` (newline characters).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
export const ALLOWLIST_PATH = join(
  REPO_ROOT,
  "scripts",
  "file-size-allowlist.json",
);
/** Keep in step with MAX_LINES in eslint.config.js. */
export const MAX_LINES = 800;

export type Allowlist = Record<string, number>;

export function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export interface Evaluation {
  problems: string[];
  warnings: string[];
}

/**
 * `lines` maps a repo-relative path to its line count, or null when missing.
 * `sourceFiles` are the capped (non-test) files; those over MAX_LINES need an entry.
 */
export function evaluate(
  allowlist: Allowlist,
  lines: (file: string) => number | null,
  sourceFiles: string[] = [],
): Evaluation {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const [file, max] of Object.entries(allowlist)) {
    const actual = lines(file);
    if (actual === null) {
      problems.push(
        `${file}: listed in file-size-allowlist.json but does not exist`,
      );
    } else if (actual <= MAX_LINES) {
      warnings.push(
        `slack: ${file} entry ${max} > actual ${actual}; run --update to tighten`,
      );
    } else if (actual > max) {
      problems.push(
        `${file}: ${actual} lines is larger than its entry ${max}; split it instead of growing it`,
      );
    } else if (max > actual) {
      warnings.push(
        `slack: ${file} entry ${max} > actual ${actual}; run --update to tighten`,
      );
    }
  }
  for (const file of sourceFiles) {
    if (file in allowlist) continue;
    const actual = lines(file);
    if (actual !== null && actual > MAX_LINES) {
      problems.push(
        `${file}: ${actual} lines is over ${MAX_LINES} and has no allowlist entry`,
      );
    }
  }
  return { problems, warnings };
}

/** Lower entries to the actual size; drop missing files and files within the cap. */
export function update(
  allowlist: Allowlist,
  lines: (file: string) => number | null,
): Allowlist {
  const next: Allowlist = {};
  for (const file of Object.keys(allowlist).sort()) {
    const actual = lines(file);
    if (actual === null || actual <= MAX_LINES) continue;
    next[file] = Math.min(allowlist[file], actual);
  }
  return next;
}

export function serialize(allowlist: Allowlist): string {
  const keys = Object.keys(allowlist).sort();
  const body = keys
    .map((k) => `  ${JSON.stringify(k)}: ${allowlist[k]}`)
    .join(",\n");
  return `{\n${body}\n}\n`;
}

const readLines = (file: string): number | null => {
  const path = join(REPO_ROOT, file);
  return existsSync(path) ? countLines(readFileSync(path, "utf8")) : null;
};

/** Same scope as the ESLint max-lines block in eslint.config.js. */
export function isCappedSource(file: string): boolean {
  return (
    /^(packages|apps)\/.*\.(ts|tsx)$/.test(file) &&
    !file.startsWith("packages/ocpp/src/") &&
    !file.includes("/__tests__/") &&
    !/\.test\.(ts|tsx)$/.test(file)
  );
}

const listSourceFiles = (): string[] =>
  execFileSync("git", ["ls-files", "packages", "apps"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(isCappedSource);

if (import.meta.main) {
  const allowlist: Allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  if (process.argv.includes("--update")) {
    writeFileSync(ALLOWLIST_PATH, serialize(update(allowlist, readLines)));
    console.log("file-size-allowlist.json updated");
  } else {
    const { problems, warnings } = evaluate(
      allowlist,
      readLines,
      listSourceFiles(),
    );
    if (warnings.length > 0) console.warn(warnings.join("\n"));
    if (problems.length > 0) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    console.log(
      `file size: ${Object.keys(allowlist).length} allowlisted files ok`,
    );
  }
}
