import { describe, expect, it, vi } from "vitest";
import {
  NGROK_DEFAULT_API_URL,
  localHostForTunnel,
  selectNgrokTunnel,
  soapTunnelStartupLines,
  startSoapTunnel,
  type SoapTunnelSpawnFn,
  type SpawnedTunnelProcess,
} from "../soapTunnel";

function streamOf(lines: string[], opts: { hold?: Promise<void> } = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      if (opts.hold) await opts.hold;
      controller.close();
    },
  });
}

const STARTED_TUNNEL_LINE =
  '{"t":"2026-09-12T20:25:17+0200","lvl":"info","msg":"started tunnel","obj":"tunnels","name":"command_line","addr":{"Scheme":"http","Host":"127.0.0.1:9700"},"url":"https://94b1-82-67-199-224.ngrok-free.app"}';
const NOISE_LINES = [
  '{"t":"2026-09-12T20:25:13+0200","lvl":"info","msg":"no configuration paths supplied"}',
  '{"t":"2026-09-12T20:25:13+0200","lvl":"info","msg":"starting web service","obj":"web","addr":"127.0.0.1:4040","allow_hosts":null}',
  "not json at all",
];

interface FakeSpawn {
  spawn: SoapTunnelSpawnFn;
  calls: Array<{ argv: string[]; env: Record<string, string | undefined> }>;
  kill: ReturnType<typeof vi.fn>;
  resolveExit: (code: number | null) => void;
}

function fakeSpawn(
  stdoutLines: string[],
  opts: { stderr?: string; holdStdout?: boolean; throws?: Error } = {},
): FakeSpawn {
  const calls: FakeSpawn["calls"] = [];
  const kill = vi.fn();
  let resolveExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });
  let releaseStdout: () => void = () => {};
  const hold = opts.holdStdout
    ? new Promise<void>((resolve) => {
        releaseStdout = resolve;
      })
    : undefined;
  const spawn: SoapTunnelSpawnFn = (argv, env) => {
    if (opts.throws) throw opts.throws;
    calls.push({ argv, env });
    const proc: SpawnedTunnelProcess = {
      stdout: streamOf(stdoutLines, { hold }),
      stderr: streamOf(opts.stderr ? [opts.stderr] : []),
      exited,
      kill: () => {
        kill();
        releaseStdout();
        resolveExit(null);
      },
    };
    return proc;
  };
  return {
    spawn,
    calls,
    kill,
    resolveExit: (code) => {
      releaseStdout();
      resolveExit(code);
    },
  };
}

describe("startSoapTunnel (spawn mode)", () => {
  it("spawns ngrok with the local address and JSON logs, and resolves the public URL", async () => {
    const fake = fakeSpawn([...NOISE_LINES, STARTED_TUNNEL_LINE], {
      holdStdout: true,
    });
    const tunnel = await startSoapTunnel({
      localHost: "127.0.0.1",
      localPort: 9700,
      spawn: fake.spawn,
    });
    expect(tunnel.provider).toBe("ngrok");
    expect(tunnel.mode).toBe("spawn");
    expect(tunnel.publicBaseUrl).toBe(
      "https://94b1-82-67-199-224.ngrok-free.app",
    );
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].argv).toEqual([
      "ngrok",
      "http",
      "127.0.0.1:9700",
      "--log",
      "stdout",
      "--log-format",
      "json",
    ]);
    tunnel.close();
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });

  it("forwards --ngrok-domain as --url", async () => {
    const fake = fakeSpawn([STARTED_TUNNEL_LINE], { holdStdout: true });
    const tunnel = await startSoapTunnel({
      localHost: "127.0.0.1",
      localPort: 9700,
      domain: "cp.example.ngrok.app",
      spawn: fake.spawn,
    });
    expect(fake.calls[0].argv).toContain("--url");
    expect(fake.calls[0].argv[fake.calls[0].argv.indexOf("--url") + 1]).toBe(
      "cp.example.ngrok.app",
    );
    tunnel.close();
  });

  it("passes the auth token through the environment, never on argv", async () => {
    const fake = fakeSpawn([STARTED_TUNNEL_LINE], { holdStdout: true });
    const tunnel = await startSoapTunnel({
      localHost: "127.0.0.1",
      localPort: 9700,
      authToken: "secret-token-123",
      spawn: fake.spawn,
    });
    expect(fake.calls[0].env.NGROK_AUTHTOKEN).toBe("secret-token-123");
    expect(fake.calls[0].argv.join(" ")).not.toContain("secret-token-123");
    tunnel.close();
  });

  it("does not set NGROK_AUTHTOKEN when no token is given (ngrok config / inherited env applies)", async () => {
    const fake = fakeSpawn([STARTED_TUNNEL_LINE], { holdStdout: true });
    const tunnel = await startSoapTunnel({
      localHost: "127.0.0.1",
      localPort: 9700,
      spawn: fake.spawn,
      env: { PATH: "/usr/bin" },
    });
    expect(fake.calls[0].env).toEqual({ PATH: "/usr/bin" });
    tunnel.close();
  });

  it("rejects on an ngrok error log line, with secrets redacted", async () => {
    const fake = fakeSpawn([
      NOISE_LINES[0],
      '{"lvl":"eror","msg":"authentication failed","err":"ERR_NGROK_107 authtoken=abc123 is invalid"}',
    ]);
    const failure = await startSoapTunnel({
      localHost: "127.0.0.1",
      localPort: 9700,
      authToken: "abc123",
      spawn: fake.spawn,
    }).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(
      /ngrok: authentication failed.*ERR_NGROK_107/,
    );
    expect(failure?.message).not.toContain("abc123");
    expect(fake.kill).toHaveBeenCalled();
  });

  it("rejects when ngrok exits before announcing a tunnel, quoting stderr", async () => {
    const fake = fakeSpawn([NOISE_LINES[0]], {
      stderr: "ERROR: authentication failed: Your authtoken is invalid.",
    });
    const pending = startSoapTunnel({
      localHost: "127.0.0.1",
      localPort: 9700,
      spawn: fake.spawn,
    });
    fake.resolveExit(1);
    await expect(pending).rejects.toThrow(
      /ngrok exited \(code 1\) before the tunnel came up.*authtoken is invalid/,
    );
  });

  it("explains a missing ngrok binary", async () => {
    const enoent = Object.assign(new Error("spawn ngrok ENOENT"), {
      code: "ENOENT",
    });
    const fake = fakeSpawn([], { throws: enoent });
    await expect(
      startSoapTunnel({
        localHost: "127.0.0.1",
        localPort: 9700,
        spawn: fake.spawn,
      }),
    ).rejects.toThrow(/ngrok binary not found in PATH.*--ngrok-api-url/);
  });

  it("kills ngrok and rejects when no tunnel is announced before the timeout", async () => {
    const fake = fakeSpawn([NOISE_LINES[0]], { holdStdout: true });
    await expect(
      startSoapTunnel({
        localHost: "127.0.0.1",
        localPort: 9700,
        spawn: fake.spawn,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out after 20 ms/);
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });

  it("reports an unexpected exit after the tunnel is up, but not after close()", async () => {
    const onExit = vi.fn();
    const fake = fakeSpawn([STARTED_TUNNEL_LINE], { holdStdout: true });
    await startSoapTunnel({
      localHost: "127.0.0.1",
      localPort: 9700,
      spawn: fake.spawn,
      onExit,
    });
    fake.resolveExit(3);
    // Plain polling: this file also runs under `bun test`, whose vitest
    // shim has no vi.waitFor.
    for (let i = 0; i < 50 && onExit.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(onExit).toHaveBeenCalledWith(3);

    const onExit2 = vi.fn();
    const fake2 = fakeSpawn([STARTED_TUNNEL_LINE], { holdStdout: true });
    const tunnel = await startSoapTunnel({
      localHost: "127.0.0.1",
      localPort: 9700,
      spawn: fake2.spawn,
      onExit: onExit2,
    });
    tunnel.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onExit2).not.toHaveBeenCalled();
  });
});

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

describe("startSoapTunnel (attach mode)", () => {
  it("reads the public URL of the https tunnel forwarding to the local port", async () => {
    const fetchImpl = fakeFetch(200, {
      tunnels: [
        {
          public_url: "https://other.ngrok-free.app",
          proto: "https",
          config: { addr: "http://localhost:8080" },
        },
        {
          public_url: "https://cp.ngrok-free.app",
          proto: "https",
          config: { addr: "http://simulator:9700" },
        },
      ],
    });
    const tunnel = await startSoapTunnel({
      localHost: "0.0.0.0",
      localPort: 9700,
      apiUrl: "http://ngrok:4040/",
      fetch: fetchImpl,
    });
    expect(tunnel.mode).toBe("attach");
    expect(tunnel.publicBaseUrl).toBe("https://cp.ngrok-free.app");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://ngrok:4040/api/tunnels",
      expect.anything(),
    );
    expect(() => tunnel.close()).not.toThrow();
  });

  it("falls back to the only https tunnel when none matches the port", async () => {
    const tunnel = await startSoapTunnel({
      localHost: "127.0.0.1",
      localPort: 9700,
      apiUrl: "http://127.0.0.1:4040",
      fetch: fakeFetch(200, {
        tunnels: [
          {
            public_url: "https://cp.ngrok-free.app",
            proto: "https",
            config: { addr: "http://host.docker.internal:9701" },
          },
        ],
      }),
    });
    expect(tunnel.publicBaseUrl).toBe("https://cp.ngrok-free.app");
  });

  it("rejects when the agent has no https tunnel", async () => {
    await expect(
      startSoapTunnel({
        localHost: "127.0.0.1",
        localPort: 9700,
        apiUrl: "http://127.0.0.1:4040",
        fetch: fakeFetch(200, { tunnels: [] }),
      }),
    ).rejects.toThrow(
      /no https tunnel forwarding to port 9700 found at http:\/\/127\.0\.0\.1:4040/,
    );
  });

  it("rejects when several https tunnels exist and none targets the port", async () => {
    await expect(
      startSoapTunnel({
        localHost: "127.0.0.1",
        localPort: 9700,
        apiUrl: "http://127.0.0.1:4040",
        fetch: fakeFetch(200, {
          tunnels: [
            {
              public_url: "https://a.ngrok-free.app",
              proto: "https",
              config: { addr: "http://localhost:1" },
            },
            {
              public_url: "https://b.ngrok-free.app",
              proto: "https",
              config: { addr: "http://localhost:2" },
            },
          ],
        }),
      }),
    ).rejects.toThrow(
      /ambiguous.*https:\/\/a\.ngrok-free\.app.*https:\/\/b\.ngrok-free\.app/,
    );
  });

  it("rejects on a non-2xx agent response", async () => {
    await expect(
      startSoapTunnel({
        localHost: "127.0.0.1",
        localPort: 9700,
        apiUrl: "http://127.0.0.1:4040",
        fetch: fakeFetch(502, {}),
      }),
    ).rejects.toThrow(/ngrok agent API .*502/);
  });

  it("rejects when the agent is unreachable", async () => {
    const failing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      startSoapTunnel({
        localHost: "127.0.0.1",
        localPort: 9700,
        apiUrl: "http://127.0.0.1:4040",
        fetch: failing,
      }),
    ).rejects.toThrow(/ngrok agent API .*ECONNREFUSED/);
  });
});

describe("selectNgrokTunnel", () => {
  it("prefers the https tunnel whose addr port matches", () => {
    const picked = selectNgrokTunnel(
      [
        {
          public_url: "http://x.ngrok-free.app",
          proto: "http",
          config: { addr: "http://localhost:9700" },
        },
        {
          public_url: "https://x.ngrok-free.app",
          proto: "https",
          config: { addr: "localhost:9700" },
        },
      ],
      9700,
    );
    expect(picked).toEqual({ ok: true, publicUrl: "https://x.ngrok-free.app" });
  });
});

describe("localHostForTunnel", () => {
  it("maps wildcard binds to loopback and keeps concrete hosts", () => {
    expect(localHostForTunnel("0.0.0.0")).toBe("127.0.0.1");
    expect(localHostForTunnel("::")).toBe("127.0.0.1");
    expect(localHostForTunnel("")).toBe("127.0.0.1");
    expect(localHostForTunnel("192.168.1.10")).toBe("192.168.1.10");
    expect(localHostForTunnel("localhost")).toBe("localhost");
  });
});

describe("soapTunnelStartupLines", () => {
  it("describes the tunnel and warns about public exposure without leaking the token", () => {
    const lines = soapTunnelStartupLines({
      tunnel: {
        provider: "ngrok",
        mode: "spawn",
        publicBaseUrl: "https://cp.ngrok-free.app",
        close: () => {},
      },
      localHost: "127.0.0.1",
      localPort: 9700,
      soapPath: "/ocpp/soap",
      cpId: "CP1",
    });
    expect(lines[0]).toBe(
      "SOAP tunnel (ngrok, spawn): https://cp.ngrok-free.app -> http://127.0.0.1:9700",
    );
    expect(lines[1]).toMatch(
      /^Warning: SOAP callback endpoint is publicly reachable/,
    );
    expect(lines[1]).toContain(
      "https://cp.ngrok-free.app/ocpp/soap/CP1/ChargePointService",
    );
    expect(lines[1]).toMatch(/identity checks/);
    expect(lines[1]).toMatch(/change between runs/);
  });

  it("uses the <cp-id> placeholder for fleets", () => {
    const lines = soapTunnelStartupLines({
      tunnel: {
        provider: "ngrok",
        mode: "attach",
        publicBaseUrl: "https://cp.ngrok-free.app",
        close: () => {},
      },
      localHost: "0.0.0.0",
      localPort: 9700,
      soapPath: "/",
      cpId: null,
    });
    expect(lines[0]).toContain("(ngrok, attach)");
    expect(lines[1]).toContain(
      "https://cp.ngrok-free.app/<cp-id>/ChargePointService",
    );
  });
});

describe("NGROK_DEFAULT_API_URL", () => {
  it("is the agent's default local address", () => {
    expect(NGROK_DEFAULT_API_URL).toBe("http://127.0.0.1:4040");
  });
});
