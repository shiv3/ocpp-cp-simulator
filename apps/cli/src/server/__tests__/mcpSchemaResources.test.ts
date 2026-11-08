import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createRuntimeDeps } from "../socketServer";
import { createMcpHandler } from "../mcp/mcpServer";
import {
  OCPP_SCHEMA_LICENSE_URL,
  OCPP_SCHEMA_NOTICE,
  listOcppSchemas,
} from "../mcp/schemaResources";
import { tailLogEntries } from "../mcp/tools";

const vendorDir = join(
  __dirname,
  "../../../../../packages/ocpp/vendor/ocpp-schemas",
);

interface Reply {
  result: {
    resources: Array<{ uri: string }>;
    contents: Array<{ uri: string; text: string }>;
    tools: Array<{ name: string }>;
    isError?: boolean;
    content: Array<{ text: string }>;
  };
}

async function rpc(method: string, params: unknown = {}): Promise<Reply> {
  const bus = new EventBus();
  const deps = createRuntimeDeps({
    registry: new CPRegistry(bus, null),
    bus,
    database: null,
  });
  const handler = createMcpHandler(deps);
  const res = await handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await res.text();
  const line = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .find((l) => l.startsWith("data: "))!
        .slice(6);
  return JSON.parse(line);
}

describe("OCPP schema MCP resources (#613)", () => {
  it("lists one resource per vendored schema file plus the notice", async () => {
    const files = ["v16", "v201", "v21"].flatMap((v) =>
      readdirSync(join(vendorDir, v)).filter((f) => f.endsWith(".json")),
    );
    const res = await rpc("resources/list");
    const uris: string[] = res.result.resources.map((r) => r.uri);
    expect(uris).toContain("ocpp-schema://NOTICE");
    expect(uris).toContain("ocpp-schema://v16/BootNotification/request");
    expect(uris).toContain("ocpp-schema://v201/BootNotification/response");
    expect(uris).toContain("ocpp-schema://v21/BootNotification/request");
    expect(uris.length).toBe(files.length + 1);
    expect(new Set(uris).size).toBe(uris.length);
  });

  it("returns the schema byte for byte, with the license notice", async () => {
    const res = await rpc("resources/read", {
      uri: "ocpp-schema://v21/BootNotification/request",
    });
    const [schema, notice] = res.result.contents;
    // Bytes, not parsed values: a re-serialized schema is a modified one.
    expect(schema.text).toBe(
      readFileSync(join(vendorDir, "v21/BootNotificationRequest.json"), "utf8"),
    );
    expect(notice.uri).toBe("ocpp-schema://NOTICE");
    expect(notice.text).toBe(readFileSync(join(vendorDir, "NOTICE"), "utf8"));
    expect(notice.text).toContain(OCPP_SCHEMA_LICENSE_URL);
  });

  it("serves the vendored NOTICE verbatim, and it names the license and links it", () => {
    const onDisk = readFileSync(join(vendorDir, "NOTICE"), "utf8");
    expect(OCPP_SCHEMA_NOTICE).toBe(onDisk);
    expect(onDisk).toContain("Open Charge Alliance");
    expect(onDisk).toContain("CC BY-ND 4.0");
    expect(onDisk).toContain("https://creativecommons.org/licenses/by-nd/4.0/");
  });

  it("links the license in the description of the notice and of every schema", async () => {
    const res = await rpc("resources/list");
    const resources = res.result.resources as Array<{
      uri: string;
      description?: string;
    }>;
    expect(resources.length).toBeGreaterThan(300);
    for (const resource of resources) {
      expect(resource.description, resource.uri).toContain(
        OCPP_SCHEMA_LICENSE_URL,
      );
      expect(resource.description, resource.uri).toContain(
        "Open Charge Alliance",
      );
    }
  });

  it("serves every vendored file byte for byte under a URI built from its file name", () => {
    const listed = new Map(listOcppSchemas().map((e) => [e.uri, e.text]));
    let checked = 0;
    for (const version of ["v16", "v201", "v21"]) {
      for (const file of readdirSync(join(vendorDir, version))) {
        if (!file.endsWith(".json")) continue;
        const base = file.slice(0, -".json".length);
        const m = /^(.+?)(Request|Response)?$/.exec(base)!;
        // 1.6 names a request after its action: "Authorize.json".
        const direction = m[2] === "Response" ? "response" : "request";
        const action = version === "v16" ? base.replace(/Response$/, "") : m[1];
        const uri = `ocpp-schema://${version}/${action}/${direction}`;
        expect(listed.get(uri), uri).toBe(
          readFileSync(join(vendorDir, version, file), "utf8"),
        );
        checked += 1;
      }
    }
    expect(checked).toBe(listed.size);
  });

  it("refuses a URI that is not a listed schema, traversal included", async () => {
    for (const uri of [
      "ocpp-schema://v21/NoSuchMessage/request",
      "ocpp-schema://v21/../NOTICE",
      "ocpp-schema://v21/BootNotification/../../v16/Authorize/request",
      "ocpp-schema://v16/../../../../etc/passwd",
    ]) {
      const res = await rpc("resources/read", { uri });
      expect((res as { error?: unknown }).error, uri).toBeDefined();
      expect(res.result, uri).toBeUndefined();
    }
  });
});

describe("tail_logs (#613)", () => {
  const entries = [
    { level: 0, type: "OCPP", message: "a" },
    { level: 1, type: "OCPP", message: "Boot accepted" },
    { level: 2, type: "WebSocket", message: "c" },
    { level: 3, type: "OCPP", message: "d" },
  ];
  it("returns the newest N, oldest first", () => {
    expect(
      tailLogEntries(entries, { lines: 2 }).map(
        (e) => (e as { message: string }).message,
      ),
    ).toEqual(["c", "d"]);
  });
  it("filters before taking the tail", () => {
    expect(tailLogEntries(entries, { level: "WARN" })).toHaveLength(2);
    expect(
      tailLogEntries(entries, { type: "OCPP", lines: 2 }).map(
        (e) => (e as { message: string }).message,
      ),
    ).toEqual(["Boot accepted", "d"]);
    expect(tailLogEntries(entries, { contains: "boot" })).toHaveLength(1);
    expect(tailLogEntries(undefined, {})).toEqual([]);
  });
  it("refuses a log type that does not exist", async () => {
    const res = await rpc("tools/call", {
      name: "tail_logs",
      arguments: { cpId: "x", type: "NoSuchType" },
    });
    expect(
      (res as { error?: unknown }).error !== undefined ||
        res.result?.isError === true,
    ).toBe(true);
  });
  it("is advertised and answers an empty tail for a charge point without logs", async () => {
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t) => t.name)).toContain("tail_logs");
    const res = await rpc("tools/call", {
      name: "tail_logs",
      arguments: { cpId: "nope" },
    });
    expect(res.result.isError).toBeUndefined();
    expect(JSON.parse(res.result.content[0].text)).toEqual([]);
  });
});
