import { describe, it, expect } from "vitest";
import * as http from "http";
import { sendCommand, stopDaemon } from "../client";

interface CaptureServer {
  url: string;
  close: () => void;
  lastAuth: () => string | undefined;
}

function startCaptureServer(): Promise<CaptureServer> {
  let lastAuthHeader: string | undefined;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      lastAuthHeader = req.headers["authorization"];
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => server.close(),
        lastAuth: () => lastAuthHeader,
      });
    });
  });
}

function basicHeader(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

describe("CLI client Basic Auth (client → daemon)", () => {
  it("sends Authorization: Basic on --send when credentials are provided", async () => {
    const srv = await startCaptureServer();
    try {
      await sendCommand(
        {
          httpUrl: srv.url,
          unixSocket: null,
          basicAuth: { username: "admin", password: "secret" },
        },
        "CP001",
        JSON.stringify({ command: "status" }),
      );
      expect(srv.lastAuth()).toBe(basicHeader("admin", "secret"));
    } finally {
      srv.close();
    }
  });

  it("omits Authorization when no credentials are provided", async () => {
    const srv = await startCaptureServer();
    try {
      await sendCommand(
        { httpUrl: srv.url, unixSocket: null },
        "CP001",
        JSON.stringify({ command: "status" }),
      );
      expect(srv.lastAuth()).toBeUndefined();
    } finally {
      srv.close();
    }
  });

  it("sends Authorization: Basic on --stop when credentials are provided", async () => {
    const srv = await startCaptureServer();
    try {
      await stopDaemon({
        httpUrl: srv.url,
        unixSocket: null,
        basicAuth: { username: "ops", password: "p@ss" },
      });
      expect(srv.lastAuth()).toBe(basicHeader("ops", "p@ss"));
    } finally {
      srv.close();
    }
  });

  it("encodes non-ASCII credentials as UTF-8 base64", async () => {
    const srv = await startCaptureServer();
    try {
      await sendCommand(
        {
          httpUrl: srv.url,
          unixSocket: null,
          basicAuth: { username: "operator", password: "パスワード" },
        },
        "CP001",
        JSON.stringify({ command: "status" }),
      );
      expect(srv.lastAuth()).toBe(basicHeader("operator", "パスワード"));
    } finally {
      srv.close();
    }
  });
});
