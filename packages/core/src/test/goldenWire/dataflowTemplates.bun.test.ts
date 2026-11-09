// The data-flow showcase templates (schema 1.7): each one is validated, then run
// by a real ScenarioExecutor against the fake CSMS, which answers the way the
// case needs. Every template is run with at least two answers and the test
// asserts which branch the run took (the nodes it visited and the frames it sent).
import { describe, expect, test } from "bun:test";
import { validateScenarioGraph } from "../../scenario/scenarioGraphValidator";
import { scenarioTemplates } from "../../utils/scenarioTemplates";
import type { CsmsResponder, WireFrame } from "./FakeCsms";
import { Rig } from "./rig";
import { runTemplate } from "./scenarioCases";

const IDS = scenarioTemplates
  .map((t) => t.id)
  .filter((id) => id.startsWith("dataflow-"));

describe("data-flow templates are well formed", () => {
  test("the set is the six shipped", () => {
    expect([...IDS].sort()).toEqual([
      "dataflow-authorize-branch-16",
      "dataflow-authorize-branch-201",
      "dataflow-call-error-handling",
      "dataflow-charge-to-soc",
      "dataflow-remote-start-reauthorize-16",
      "dataflow-remote-start-reauthorize-201",
    ]);
  });

  for (const id of IDS) {
    test(`${id}: validateScenarioGraph finds nothing`, () => {
      const def = scenarioTemplates
        .find((t) => t.id === id)!
        .createScenario("CP", 1);
      expect(validateScenarioGraph(def)).toEqual([]);
    });
  }
});

function calls(rig: Rig, action: string): WireFrame[] {
  return rig.csms.frames.filter(
    (f) => f.dir === "CP>" && f.kind === "call" && f.action === action,
  );
}

/** Shorten every wait so a run takes a few seconds, not a few minutes. */
function quick(def: { nodes: unknown[] }): void {
  for (const node of def.nodes as {
    type: string;
    data: Record<string, unknown>;
  }[]) {
    if (node.type === "meterValue") {
      node.data.incrementInterval = 1;
      node.data.maxTime = 1.5;
    }
    if (node.type === "delay") node.data.delaySeconds = 0.2;
  }
}

async function run(
  version: "1.6" | "2.0.1",
  id: string,
  responders: Record<string, CsmsResponder>,
  edit: (def: { nodes: unknown[] }) => void = quick,
): Promise<{ rig: Rig; visited: string[] }> {
  const rig = await Rig.create({ version, responders });
  const visited: string[] = [];
  await runTemplate(rig, id, {
    visited,
    edit: (def) => edit(def as unknown as { nodes: unknown[] }),
  });
  return { rig, visited };
}

const AUTHORIZE_BRANCHES: readonly {
  status: string;
  branch: "tx-start" | "denied" | "busy" | "other";
}[] = [
  { status: "Accepted", branch: "tx-start" },
  { status: "Blocked", branch: "denied" },
  { status: "Invalid", branch: "denied" },
  { status: "Expired", branch: "denied" },
  { status: "ConcurrentTx", branch: "busy" },
  { status: "PendingTx", branch: "other" },
];

describe("dataflow-authorize-branch", () => {
  for (const version of ["16", "201"] as const) {
    for (const { status, branch } of AUTHORIZE_BRANCHES) {
      test.concurrent(
        `${version}: ${status} takes ${branch}`,
        async () => {
          const wire = version === "16" ? "1.6" : "2.0.1";
          const { rig, visited } = await run(
            wire,
            `dataflow-authorize-branch-${version}`,
            {
              Authorize: () =>
                version === "16"
                  ? { idTagInfo: { status } }
                  : { idTokenInfo: { status } },
            },
          );
          try {
            for (const other of ["tx-start", "denied", "busy", "other"]) {
              expect(visited.includes(other)).toBe(other === branch);
            }
            expect(visited.at(-1)).toBe("end-1");
            const started =
              version === "16"
                ? calls(rig, "StartTransaction")
                : calls(rig, "TransactionEvent");
            expect(started.length > 0).toBe(branch === "tx-start");
          } finally {
            await rig.dispose();
          }
        },
        60_000,
      );
    }
  }
});

describe("dataflow-remote-start-reauthorize", () => {
  for (const version of ["16", "201"] as const) {
    for (const status of ["Accepted", "Blocked"]) {
      test.concurrent(
        `${version}: Authorize answered ${status}`,
        async () => {
          const wire = version === "16" ? "1.6" : "2.0.1";
          const { rig, visited } = await run(
            wire,
            `dataflow-remote-start-reauthorize-${version}`,
            {
              // Only the template's own Authorize (for the CSMS's tag) is
              // answered ${status}; the gate of the transaction start is not.
              Authorize: (p) => {
                const tag =
                  version === "16"
                    ? String(p.idTag)
                    : String((p.idToken as { idToken: string }).idToken);
                const answer = tag === "CSMS-RS" ? status : "Accepted";
                return version === "16"
                  ? { idTagInfo: { status: answer } }
                  : { idTokenInfo: { status: answer } };
              },
            },
          );
          try {
            const first = calls(rig, "Authorize")[0];
            expect(JSON.stringify(first.payload)).toContain("CSMS-RS");
            expect(visited).toContain("answer");
            expect(visited.includes("tx-start")).toBe(status === "Accepted");
            expect(visited.includes("denied")).toBe(status !== "Accepted");
            // The replaced CALL was answered by the template, not the station.
            const remote = rig.csms.frames.find(
              (f) =>
                f.dir === "CSMS>" &&
                f.kind === "call" &&
                /StartTransaction$/.test(f.action ?? ""),
            )!;
            const reply = rig.csms.frames.find(
              (f) =>
                f.dir === "CP>" && f.kind === "result" && f.id === remote.id,
            )!;
            expect(reply.payload).toEqual({ status: "Accepted" });
          } finally {
            await rig.dispose();
          }
        },
        60_000,
      );
    }
  }
});

describe("dataflow-call-error-handling", () => {
  const CASES: readonly { name: string; reply: unknown; report: string }[] = [
    {
      name: "Accepted",
      reply: { result: { status: "Accepted" } },
      report: "ok",
    },
    {
      name: "UnknownVendorId",
      reply: { result: { status: "UnknownVendorId" } },
      report: "unknown",
    },
    {
      name: "UnknownMessageId",
      reply: { result: { status: "UnknownMessageId" } },
      report: "unknown",
    },
    {
      name: "Rejected",
      reply: { result: { status: "Rejected" } },
      report: "rejected",
    },
    ...[
      ["NotImplemented", "unsupported"],
      ["NotSupported", "unsupported"],
      ["FormationViolation", "malformed"],
      ["TypeConstraintViolation", "malformed"],
      ["InternalError", "internal"],
      ["GenericError", "other-error"],
    ].map(([code, report]) => ({
      name: `CALLERROR ${code}`,
      reply: { error: { code, description: "test" } },
      report,
    })),
  ];
  for (const version of ["1.6", "2.0.1"] as const) {
    for (const c of CASES) {
      test.concurrent(
        `${version}: ${c.name} reports ${c.report}`,
        async () => {
          const { rig } = await run(
            version,
            "dataflow-call-error-handling",
            {
              DataTransfer: (p) =>
                p.messageId === "probe" ? c.reply : { status: "Accepted" },
            },
            () => undefined,
          );
          try {
            const sent = calls(rig, "DataTransfer").map(
              (f) => (f.payload as { messageId: string }).messageId,
            );
            expect(sent).toEqual(["probe", c.report]);
          } finally {
            await rig.dispose();
          }
        },
        60_000,
      );
    }
  }
});

describe("dataflow-charge-to-soc", () => {
  for (const { initialSoc, passes } of [
    { initialSoc: 70, passes: 3 },
    { initialSoc: 79, passes: 1 },
    { initialSoc: 85, passes: 1 },
  ]) {
    test.concurrent(
      `starting at ${initialSoc}% loops ${passes} time(s) before it stops`,
      async () => {
        const { visited } = await run(
          "1.6",
          "dataflow-charge-to-soc",
          {},
          (def) => {
            quick(def);
            const tx = (
              def.nodes as { id: string; data: Record<string, unknown> }[]
            ).find((n) => n.id === "tx-start")!;
            tx.data.initialSoc = initialSoc;
          },
        );
        expect(visited.filter((n) => n === "meter")).toHaveLength(passes);
        expect(visited.filter((n) => n === "check")).toHaveLength(passes);
        expect(visited.slice(-4)).toEqual([
          "check",
          "tx-stop",
          "plug-out",
          "end-1",
        ]);
      },
      60_000,
    );
  }
});
