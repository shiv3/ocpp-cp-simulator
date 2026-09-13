// Runs under `bun test`: startServer pulls in the `bun:sqlite` built-in.
import { describe, expect, it, mock } from "bun:test";

import type { SoapTunnel, SoapTunnelOptions } from "../../soapTunnel";
import { expandExplicitSoapCallbackUrl, openSoapTunnel } from "../startServer";

const base = {
  soapTunnel: null,
  soapCallbackUrlExplicit: null,
  soapPublicBaseUrl: null,
  httpHost: "127.0.0.1",
};
const ngrok = {
  provider: "ngrok" as const,
  authToken: null,
  domain: null,
  apiUrl: null,
  localPort: 0,
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
    expect(await openSoapTunnel(base, 9702, () => {}, start)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("forwards the SOAP-only listener's port, with a wildcard bind mapped to loopback and the ngrok options passed through", async () => {
    const { start, calls } = fakeStart();
    const onExit = mock(() => {});
    const tunnel = await openSoapTunnel(
      {
        ...base,
        httpHost: "0.0.0.0",
        soapTunnel: {
          ...ngrok,
          authToken: "tok-1",
          domain: "cp.example.ngrok.app",
        },
      },
      9702,
      onExit,
      start,
    );
    expect(tunnel?.publicBaseUrl).toBe("https://a1b2.ngrok-free.app");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      localHost: "127.0.0.1",
      localPort: 9702,
      authToken: "tok-1",
      domain: "cp.example.ngrok.app",
      apiUrl: null,
    });
    // The agent's exit reaches the daemon's own handler untouched.
    calls[0].onExit?.(3);
    expect(onExit).toHaveBeenCalledWith(3);
  });

  it("refuses a tunnel next to an explicit callback URL or public base (programmatic callers bypass parseArgs)", async () => {
    const { start, calls } = fakeStart();
    await expect(
      openSoapTunnel(
        { ...base, soapTunnel: ngrok, soapPublicBaseUrl: "https://x.test" },
        9702,
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
        9702,
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
