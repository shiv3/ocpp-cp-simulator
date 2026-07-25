/**
 * Sanitize a string for logging by escaping control characters.
 * Prevents log-forging attacks where newlines could inject fake log entries.
 *
 * - CR (\r) → "\\r"
 * - LF (\n) → "\\n"
 * - C0 control chars (0x00-0x1F except \r and \n) → "\\xHH" (2-digit hex)
 * - DEL (0x7F) → "\\x7f"
 * - Printable chars and valid UTF-8 multi-byte sequences → kept unchanged
 *
 * Returns early (allocation-cheap) if no control chars detected.
 */
export function sanitizeForLog(value: string): string {
  let hasControlChar = false;

  // Fast scan to check if sanitization is needed
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) {
      hasControlChar = true;
      break;
    }
  }

  // Early return if no control chars (allocation-cheap)
  if (!hasControlChar) {
    return value;
  }

  // Build escaped string
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    if (code === 0x0d) {
      // \r (carriage return)
      result += "\\r";
    } else if (code === 0x0a) {
      // \n (line feed)
      result += "\\n";
    } else if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) {
      // Other C0 control chars or DEL
      result += "\\x" + code.toString(16).padStart(2, "0");
    } else {
      // Printable char or multi-byte UTF-8 sequence
      result += value[i];
    }
  }

  return result;
}
