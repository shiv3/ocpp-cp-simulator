/**
 * Saves `text` as a `filename` download of `type`. The anchor is attached for
 * the click, and the object URL revoked on the next tick: Safari aborts a
 * download whose URL is revoked before it starts.
 */
export function downloadText(
  text: string,
  filename: string,
  type: string,
): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Saves `data` as a pretty-printed `filename` JSON download. */
export function downloadJson(data: unknown, filename: string): void {
  downloadText(JSON.stringify(data, null, 2), filename, "application/json");
}
