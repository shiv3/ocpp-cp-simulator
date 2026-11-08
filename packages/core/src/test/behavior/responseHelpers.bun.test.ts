import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { runBehavior, type BehaviorRun } from "./runBehavior";

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});

/** A behavior that answers `action` with what the helper returns. */
function answering(
  action: string,
  kind: "accepted" | "rejected",
  seen: unknown[],
): Behavior {
  return {
    api: 1,
    id: `canned-${kind}`,
    onCall: {
      [action]: {
        mode: "replace",
        handle(_req, ctx) {
          try {
            const response = ctx[kind](action);
            seen.push(response);
            return { response };
          } catch (error) {
            seen.push(`throws: ${(error as Error).message}`);
            return { noResponse: true };
          }
        },
      },
    },
  };
}

async function ask(
  version: "1.6" | "2.0.1",
  action: string,
  kind: "accepted" | "rejected",
  payload: unknown = {},
): Promise<unknown[]> {
  const seen: unknown[] = [];
  const run = await runBehavior({
    version,
    behaviors: [answering(action, kind, seen)],
  });
  runs.push(run);
  run.callNoWait(action, payload);
  await run.settle();
  return seen;
}

describe("ctx.accepted / ctx.rejected", () => {
  test("1.6 UpdateFirmware is accepted with {}", async () => {
    expect(await ask("1.6", "UpdateFirmware", "accepted")).toEqual([{}]);
  });

  test("2.x UpdateFirmware is accepted with a status", async () => {
    expect(await ask("2.0.1", "UpdateFirmware", "accepted")).toEqual([
      { status: "Accepted" },
    ]);
  });

  test("Reset: status on both versions, accepted and rejected", async () => {
    expect(await ask("1.6", "Reset", "accepted")).toEqual([
      { status: "Accepted" },
    ]);
    expect(await ask("2.0.1", "Reset", "rejected")).toEqual([
      { status: "Rejected" },
    ]);
  });

  test("1.6 UpdateFirmware has no rejected answer: a clear error", async () => {
    const [seen] = await ask("1.6", "UpdateFirmware", "rejected");
    expect(seen).toMatch(
      /^throws: ctx\.rejected\("UpdateFirmware"\).*no Rejected answer/,
    );
  });

  test("an action whose response needs more than a status throws", async () => {
    const [seen] = await ask("2.0.1", "GetVariables", "accepted");
    expect(seen).toMatch(/^throws: ctx\.accepted\("GetVariables"\)/);
  });

  test("a 1.6 spelling is understood on 2.x", async () => {
    const seen: unknown[] = [];
    const run = await runBehavior({
      version: "2.0.1",
      behaviors: [
        {
          api: 1,
          id: "alias",
          onCall: {
            RequestStartTransaction: {
              mode: "replace",
              handle: (_r, ctx) => {
                seen.push(ctx.accepted("RemoteStartTransaction"));
                return { noResponse: true };
              },
            },
          },
        },
      ],
    });
    runs.push(run);
    run.callNoWait("RequestStartTransaction", {
      remoteStartId: 1,
      idToken: { idToken: "A", type: "Central" },
    });
    await run.settle();
    expect(seen).toEqual([{ status: "Accepted" }]);
  });
});
