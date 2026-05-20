/** Mirrors query params applied in OCPPWebSocket.connect(). */
export function buildFullOcppUrl(
  wsURL: string,
  chargePointId: string,
  authToken: string,
  basicAuth: { enabled: boolean; username: string; password: string },
): string {
  const base = wsURL.trim();
  if (!base) return "";

  try {
    const url = new URL(base);
    if (authToken.trim()) {
      url.searchParams.set("key", authToken.trim());
    } else {
      url.searchParams.delete("key");
      url.searchParams.delete("token");
    }
    if (chargePointId.trim()) {
      url.searchParams.set("cpid", chargePointId.trim());
    } else {
      url.searchParams.delete("cpid");
    }
    if (basicAuth.enabled && basicAuth.username) {
      url.username = basicAuth.username;
      url.password = basicAuth.password;
    } else {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    return base;
  }
}

export interface ParsedOcppUrl {
  wsURL: string;
  chargePointId: string;
  authToken: string;
  basicAuthEnabled: boolean;
  basicAuthUsername: string;
  basicAuthPassword: string;
}

/** Split a pasted/typed WebSocket URL back into Settings form fields. */
export function parseFullOcppUrl(fullUrl: string): ParsedOcppUrl | null {
  const trimmed = fullUrl.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);

    const chargePointId =
      url.searchParams.get("cpid") ?? url.searchParams.get("CPID") ?? "";
    const authToken =
      url.searchParams.get("key") ?? url.searchParams.get("token") ?? "";

    url.searchParams.delete("cpid");
    url.searchParams.delete("CPID");
    url.searchParams.delete("key");
    url.searchParams.delete("token");

    const basicAuthUsername = decodeURIComponent(url.username);
    const basicAuthPassword = decodeURIComponent(url.password);
    url.username = "";
    url.password = "";

    return {
      wsURL: url.toString(),
      chargePointId,
      authToken,
      basicAuthEnabled: !!(basicAuthUsername || basicAuthPassword),
      basicAuthUsername,
      basicAuthPassword,
    };
  } catch {
    return null;
  }
}
