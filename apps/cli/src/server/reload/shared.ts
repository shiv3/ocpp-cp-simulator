import * as fs from "fs";

/** Clamp a string to `max`, marking it when something was dropped. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function readTextOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}
