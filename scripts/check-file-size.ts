// scripts/check-file-size.ts
//
// Line ratchet for non-test source files (#877). ESLint `max-lines` caps every
// file under packages/ and apps/ at MAX_LINES, and caps each file listed in
// scripts/file-size-allowlist.json at the size recorded there, so a file that
// is over the limit today may not grow. ESLint cannot see an entry that is
// looser than its file, so this check does:
//
//   (a) an entry names a file that does not exist,
//   (b) an entry is larger than the file's actual line count,
//   (c) the file is at or under MAX_LINES and the entry is still there.
//
//   bun run scripts/check-file-size.ts            # exit 1 on any problem
//   bun run scripts/check-file-size.ts --update   # lower entries to the actual
//                                                 # size, drop the ones that fit;
//                                                 # never raises an entry
//
// Lines are counted like `wc -l` (newline characters).

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

/** `lines` maps a repo-relative path to its line count, or null when missing. */
export function evaluate(
  allowlist: Allowlist,
  lines: (file: string) => number | null,
): string[] {
  const problems: string[] = [];
  for (const [file, max] of Object.entries(allowlist)) {
    const actual = lines(file);
    if (actual === null) {
      problems.push(
        `${file}: listed in file-size-allowlist.json but does not exist`,
      );
    } else if (actual <= MAX_LINES) {
      problems.push(
        `${file}: ${actual} lines is within ${MAX_LINES}; remove the entry (--update)`,
      );
    } else if (max > actual) {
      problems.push(
        `${file}: entry ${max} is larger than the actual ${actual} lines; lower it (--update)`,
      );
    }
  }
  return problems;
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

if (import.meta.main) {
  const allowlist: Allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  if (process.argv.includes("--update")) {
    writeFileSync(ALLOWLIST_PATH, serialize(update(allowlist, readLines)));
    console.log("file-size-allowlist.json updated");
  } else {
    const problems = evaluate(allowlist, readLines);
    if (problems.length > 0) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    console.log(
      `file size: ${Object.keys(allowlist).length} allowlisted files ok`,
    );
  }
}
