/* eslint-disable @typescript-eslint/no-explicit-any -- test ack payloads */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import {
  CP_CREATE_MANY_MAX,
  expandIdPattern,
  MAX_GENERATED_CP_ID_LENGTH,
} from "../../../protocol";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

async function startAndTrack(): Promise<TestServer> {
  const server = await startTestServer();
  servers.push(server);
  return server;
}

function rpc(socket: Socket, method: string, params: unknown): Promise<any> {
  return new Promise((resolve) =>
    socket.emit("rpc", { method, params }, resolve),
  );
}

const SHARED = {
  wsUrl: "ws://example.test/ocpp/",
  connectors: 2,
  vendor: "Acme",
  model: "Fleet",
};

describe("cp.create_many (#295)", () => {
  it("creates the whole batch, in id order, from one call", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const ack = await rpc(socket, "cp.create_many", {
        ...SHARED,
        count: 5,
        idPattern: "CP{n:03}",
      });

      expect(ack.ok).toBe(true);
      expect(ack.result.failed).toEqual([]);
      // Sequential creation is a contract, not an incidental: registry events
      // arrive in this order and subscribers are allowed to rely on it.
      expect(ack.result.created).toEqual([
        "CP001",
        "CP002",
        "CP003",
        "CP004",
        "CP005",
      ]);

      const list = await rpc(socket, "cp.list", {});
      const ids = (list.result as Array<{ cpId: string }>)
        .map((cp) => cp.cpId)
        .sort();
      expect(ids).toEqual(["CP001", "CP002", "CP003", "CP004", "CP005"]);
    } finally {
      socket.disconnect();
    }
  });

  it("shares every non-id parameter with each charge point", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      await rpc(socket, "cp.create_many", {
        ...SHARED,
        count: 2,
        idPattern: "SHARED{n}",
      });

      const list = await rpc(socket, "cp.list", {});
      for (const cp of list.result as Array<Record<string, unknown>>) {
        expect(cp.wsUrl).toBe(SHARED.wsUrl);
        expect(cp.connectors).toBe(SHARED.connectors);
      }
    } finally {
      socket.disconnect();
    }
  });

  it("keeps the charge points that worked when one id collides", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      // DUP002 already exists, so the batch cannot create it a second time.
      // The other two must survive: rolling them back because of one bad id
      // is the behaviour this method exists to avoid.
      const first = await rpc(socket, "cp.create", {
        ...SHARED,
        cpId: "DUP002",
      });
      expect(first.ok).toBe(true);

      const ack = await rpc(socket, "cp.create_many", {
        ...SHARED,
        count: 3,
        idPattern: "DUP{n:03}",
      });

      expect(ack.ok).toBe(true);
      expect(ack.result.created).toEqual(["DUP001", "DUP003"]);
      expect(ack.result.failed).toHaveLength(1);
      expect(ack.result.failed[0].cpId).toBe("DUP002");
      // The daemon blanks the message for an "already exists" collision
      // (it could carry a CSMS URL), so the row falls back to the error code
      // rather than reporting an empty reason.
      expect(ack.result.failed[0].reason).toBe("invalid_params");
    } finally {
      socket.disconnect();
    }
  });

  it("honours startIndex", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const ack = await rpc(socket, "cp.create_many", {
        ...SHARED,
        count: 3,
        idPattern: "OFF{n:02}",
        startIndex: 10,
      });
      expect(ack.result.created).toEqual(["OFF10", "OFF11", "OFF12"]);
    } finally {
      socket.disconnect();
    }
  });

  it("refuses a count above the enforced ceiling", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const ack = await rpc(socket, "cp.create_many", {
        ...SHARED,
        count: CP_CREATE_MANY_MAX + 1,
        idPattern: "TOOMANY{n}",
      });

      // The ceiling is enforced, not merely documented: this is the one
      // control-plane call that allocates unbounded resources per request.
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");

      const list = await rpc(socket, "cp.list", {});
      expect(list.result).toHaveLength(0);
    } finally {
      socket.disconnect();
    }
  });

  it("refuses an idPattern with no index placeholder", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      // Without a placeholder every charge point would be asked for under the
      // same id, so all but the first would collide -- better to say so.
      const ack = await rpc(socket, "cp.create_many", {
        ...SHARED,
        count: 2,
        idPattern: "NOPLACEHOLDER",
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");
    } finally {
      socket.disconnect();
    }
  });
});

describe("expandIdPattern", () => {
  it("substitutes the index, zero-padding when a width is given", () => {
    expect(expandIdPattern("CP{n:03}", 7)).toBe("CP007");
    expect(expandIdPattern("CP{n}", 7)).toBe("CP7");
    expect(expandIdPattern("{n:02}-{n}", 5)).toBe("05-5");
    // A width narrower than the number does not truncate it.
    expect(expandIdPattern("CP{n:02}", 1234)).toBe("CP1234");
  });
});

describe("cp.create_many SOAP callbacks (#295)", () => {
  it("expands the placeholder so each station gets its own callback route", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const ack = await rpc(socket, "cp.create_many", {
        wsUrl: "http://csms.example/CentralSystemService",
        ocppVersion: "OCPP-1.6S",
        connectors: 1,
        count: 2,
        idPattern: "SOAP{n:02}",
        soapCallbackUrl:
          "http://sim.example:9700/ocpp/soap/SOAP{n:02}/ChargePointService",
      });

      expect(ack.ok).toBe(true);
      expect(ack.result.created).toEqual(["SOAP01", "SOAP02"]);
    } finally {
      socket.disconnect();
    }
  });

  it("refuses a batch whose callback URL would be shared", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      // The daemon routes inbound CS→CP calls by the cpId inside this URL, so
      // one address across a batch sends every station's callbacks to the
      // first station's route — and the creates would all succeed while doing
      // it, which is the failure worth refusing up front.
      const ack = await rpc(socket, "cp.create_many", {
        wsUrl: "http://csms.example/CentralSystemService",
        ocppVersion: "OCPP-1.6S",
        connectors: 1,
        count: 2,
        idPattern: "SHARED{n:02}",
        soapCallbackUrl:
          "http://sim.example:9700/ocpp/soap/SHARED01/ChargePointService",
      });

      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");
      expect(ack.error.message).toContain("soapCallbackUrl");

      const list = await rpc(socket, "cp.list", {});
      expect(list.result).toHaveLength(0);
    } finally {
      socket.disconnect();
    }
  });

  it("allows a single SOAP charge point to keep a plain callback URL", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const ack = await rpc(socket, "cp.create_many", {
        wsUrl: "http://csms.example/CentralSystemService",
        ocppVersion: "OCPP-1.6S",
        connectors: 1,
        count: 1,
        idPattern: "SOLO{n:02}",
        soapCallbackUrl:
          "http://sim.example:9700/ocpp/soap/SOLO01/ChargePointService",
      });
      expect(ack.ok).toBe(true);
      expect(ack.result.created).toEqual(["SOLO01"]);
    } finally {
      socket.disconnect();
    }
  });
});

describe("idPattern padding width (#295)", () => {
  it("refuses a width wide enough to blow past the id size cap", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      // {n:065537} would pad the id past STR_64K: the charge point would be
      // created and only then would result validation fail, reporting an
      // internal error over a side effect that already happened.
      const ack = await rpc(socket, "cp.create_many", {
        ...SHARED,
        count: 1,
        idPattern: "WIDE{n:065537}",
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");

      const list = await rpc(socket, "cp.list", {});
      expect(list.result).toHaveLength(0);
    } finally {
      socket.disconnect();
    }
  });
});

describe("expanded ids are bounded, not just the pad width (#295)", () => {
  it("refuses a pattern that repeats the placeholder into a huge id", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      // The width cap alone does not bound the result: this is a few KB of
      // schema-valid input that expands to tens of KB per id, and the charge
      // point would be registered before the result failed to validate.
      const ack = await rpc(socket, "cp.create_many", {
        ...SHARED,
        count: 2,
        idPattern: "{n:99}".repeat(200),
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");

      // Rejected before any side effect: nothing was created.
      const list = await rpc(socket, "cp.list", {});
      expect(list.result).toHaveLength(0);
    } finally {
      socket.disconnect();
    }
  });

  it("accepts an id right at the limit", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const stem = "C".repeat(MAX_GENERATED_CP_ID_LENGTH - 3);
      const ack = await rpc(socket, "cp.create_many", {
        ...SHARED,
        count: 1,
        idPattern: `${stem}{n:03}`,
      });
      expect(ack.ok).toBe(true);
      expect(ack.result.created[0]).toHaveLength(MAX_GENERATED_CP_ID_LENGTH);
    } finally {
      socket.disconnect();
    }
  });
});

describe("SOAP callback routes must match the generated ids (#295)", () => {
  it("refuses a placeholder spelled differently from idPattern", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      // Registers SOAP001 while advertising a route for SOAP1: the SOAP router
      // looks up that exact path segment, so every inbound call 404s — and the
      // creates would all have reported success.
      const ack = await rpc(socket, "cp.create_many", {
        wsUrl: "http://csms.example/CentralSystemService",
        ocppVersion: "OCPP-1.6S",
        connectors: 1,
        count: 2,
        idPattern: "SOAP{n:03}",
        soapCallbackUrl:
          "http://sim.example:9700/ocpp/soap/SOAP{n}/ChargePointService",
      });

      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");
      const list = await rpc(socket, "cp.list", {});
      expect(list.result).toHaveLength(0);
    } finally {
      socket.disconnect();
    }
  });

  it("accepts a callback whose placeholder matches", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const ack = await rpc(socket, "cp.create_many", {
        wsUrl: "http://csms.example/CentralSystemService",
        ocppVersion: "OCPP-1.6S",
        connectors: 1,
        count: 2,
        idPattern: "MATCH{n:03}",
        soapCallbackUrl:
          "http://sim.example:9700/ocpp/soap/MATCH{n:03}/ChargePointService",
      });
      expect(ack.ok).toBe(true);
      expect(ack.result.created).toEqual(["MATCH001", "MATCH002"]);
    } finally {
      socket.disconnect();
    }
  });
});

describe("cp.update declares autoConnect too (#295)", () => {
  it("advertises it on both methods, since both honour it", async () => {
    // `updateCp` reads autoConnect off the raw params as a reconnect. Leaving
    // it off updateParamsSchema made list_methods advertise a schema that
    // omitted it, so schema-driven clients could not discover the option.
    const { METHODS } = await import("../../../protocol");
    for (const method of ["cp.create", "cp.update"] as const) {
      const shape = (
        METHODS[method].params as unknown as {
          shape: Record<string, unknown>;
        }
      ).shape;
      expect(Object.keys(shape)).toContain("autoConnect");
    }
  });
});
