/**
 * Destination check for a real log / diagnostics upload (#926). The CSMS
 * names the URL, so the station must not be steered at the machine it runs on
 * or at its internal network (SSRF): only `http` and `https`, no embedded
 * credentials, and, unless the operator allows private hosts, no loopback,
 * private, link-local, unique-local or metadata address and no `localhost` /
 * `.local` / `.internal` name.
 *
 * It judges the URL text only. A public name that resolves to a private
 * address (DNS rebinding) is not caught here: the core runs in the browser
 * too and cannot resolve names. Redirects are not followed by the uploader,
 * so a redirect cannot lead to a private host either.
 */
export type UploadUrlVerdict =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: string };

/** `a.b.c.d` as four numbers, else null. */
function ipv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts as [number, number, number, number];
}

function isPrivateIpv4([a, b]: [number, number, number, number]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:abcd:ef01)
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) {
    const v4 = ipv4(mapped[1]!);
    if (v4) return isPrivateIpv4(v4);
    return true; // hex form: refuse, it hides an IPv4 address
  }
  return (
    /^f[cd]/.test(h) || // fc00::/7 unique local
    /^fe[89ab]/.test(h) || // fe80::/10 link-local
    h.startsWith("ff") // multicast
  );
}

export function checkUploadUrl(
  raw: string,
  allowPrivateHosts: boolean,
): UploadUrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: `scheme ${url.protocol.replace(":", "")} is not supported (http and https only)`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "credentials in the URL are not accepted" };
  }
  if (allowPrivateHosts) return { ok: true, url };
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const v4 = ipv4(host);
  const internalName =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal";
  if (
    internalName ||
    (v4 && isPrivateIpv4(v4)) ||
    (host.includes(":") && isPrivateIpv6(host))
  ) {
    return {
      ok: false,
      reason: "the host is a loopback, private or internal address",
    };
  }
  return { ok: true, url };
}
