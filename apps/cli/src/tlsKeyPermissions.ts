import * as fs from "fs";

export function tlsKeyPermissionWarning(filePath: string): string | null {
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return `TLS private key file '${filePath}' is accessible by group/other; expected mode 0600`;
    }
  } catch {
    // The caller's PEM read path reports the actionable file access failure.
  }
  return null;
}
