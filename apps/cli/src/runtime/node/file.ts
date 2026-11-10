/**
 * Static files on Node (#916). `new Response(Bun.file(p))` sets the
 * content-type from the extension; this does the same with the types Bun
 * reports for what the web console ships (HTML, JS, CSS, fonts, images,
 * manifests, source maps), and `application/octet-stream` otherwise.
 */
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { RuntimeFile } from "../types";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html;charset=utf-8",
  ".htm": "text/html;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".mjs": "text/javascript;charset=utf-8",
  ".cjs": "text/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".map": "application/json;charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain;charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

export function contentTypeFor(file: string): string {
  return (
    CONTENT_TYPES[path.extname(file).toLowerCase()] ??
    "application/octet-stream"
  );
}

export function nodeFile(file: string): RuntimeFile {
  return {
    async exists() {
      try {
        return (await stat(file)).isFile();
      } catch {
        return false;
      }
    },
    async response() {
      const bytes = await readFile(file);
      return new Response(bytes, {
        headers: { "content-type": contentTypeFor(file) },
      });
    },
  };
}
