// Runs under `bun test`: startServer pulls in the `bun:sqlite` built-in.
import { describe, expect, it, mock } from "bun:test";

import type { SoapTunnel, SoapTunnelOptions } from "../../soapTunnel";
import { expandExplicitSoapCallbackUrl, openSoapTunnel } from "../startServer";

const base = {
  soapTunnel: null,
  soapCallbackUrlExplicit: null,
  soapPublicBaseUrl: null,
  httpHost: "127.0.0.1",
  httpPort: 9700 as number | null,
  webConsolePort: null as number | null,
};
const ngrok = {
  provider: "ngrok" as const,
  authToken: null,
  domain: null,
  apiUrl: null,
};

function fakeStart() {
  const calls: SoapTunnelOptions[] = [];
  const start = async (opts: SoapTunnelOptions): Promise<SoapTunnel> => {
    calls.push(opts);
    return {
      provider: "ngrok",
      mode: "spawn",
      publicBaseUrl: "https://a1b2.ngrok-free.app",
      localHost: opts.localHost,
      localPort: opts.localPort,
      close: () => {},
    };
  };
  return { start, calls };
}

describe("openSoapTunnel (#183)", () => {
  it("opens nothing without --soap-tunnel", async () => {
    const { start, calls } = fakeStart();
    expect(await openSoapTunnel(base, () => {}, start)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("forwards the API listener, with a wildcard bind mapped to loopback and the ngrok options passed through", async () => {
    const { start, calls } = fakeStart();
    const onExit = mock(() => {});
    const tunnel = await openSoapTunnel(
      {
        ...base,
        httpHost: "0.0.0.0",
        webConsolePort: 9701,
        soapTunnel: {
          ...ngrok,
          authToken: "tok-1",
          domain: "cp.example.ngrok.app",
        },
      },
      onExit,
      start,
    );
    expect(tunnel?.publicBaseUrl).toBe("https://a1b2.ngrok-free.app");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      localHost: "127.0.0.1",
      localPort: 9700,
      authToken: "tok-1",
      domain: "cp.example.ngrok.app",
      apiUrl: null,
    });
    // The agent's exit reaches the daemon's own handler untouched.
    calls[0].onExit?.(3);
    expect(onExit).toHaveBeenCalledWith(3);
  });

  it("falls back to the console listener when there is no API port", async () => {
    const { start, calls } = fakeStart();
    await openSoapTunnel(
      { ...base, httpPort: null, webConsolePort: 8080, soapTunnel: ngrok },
      () => {},
      start,
    );
    expect(calls[0]?.localPort).toBe(8080);
  });

  it("refuses to start without any listener", async () => {
    const { start } = fakeStart();
    await expect(
      openSoapTunnel(
        { ...base, httpPort: null, soapTunnel: ngrok },
        () => {},
        start,
      ),
    ).rejects.toThrow(/needs a listener/);
  });

  it("refuses a tunnel next to an explicit callback URL or public base (programmatic callers bypass parseArgs)", async () => {
    const { start, calls } = fakeStart();
    await expect(
      openSoapTunnel(
        { ...base, soapTunnel: ngrok, soapPublicBaseUrl: "https://x.test" },
        () => {},
        start,
      ),
    ).rejects.toThrow(/cannot be combined/);
    await expect(
      openSoapTunnel(
        {
          ...base,
          soapTunnel: ngrok,
          soapCallbackUrlExplicit:
            "https://x.test/ocpp/soap/CP1/ChargePointService",
        },
        () => {},
        start,
      ),
    ).rejects.toThrow(/cannot be combined/);
    expect(calls).toHaveLength(0);
  });
});

describe("expandExplicitSoapCallbackUrl (fleet)", () => {
  it("expands the {n} placeholder and checks the route segment", () => {
    expect(
      expandExplicitSoapCallbackUrl(
        "https://cs.test/ocpp/soap/CP-{n}/ChargePointService",
        "CP-2",
        2,
      ),
    ).toBe("https://cs.test/ocpp/soap/CP-2/ChargePointService");
  });

  it("rejects a URL whose route segment would not reach the charge point", () => {
    expect(() =>
      expandExplicitSoapCallbackUrl(
        "https://cs.test/ocpp/soap/OTHER/ChargePointService",
        "CP-1",
        1,
      ),
    ).toThrow(/route segment is not "CP-1"/);
  });
});
