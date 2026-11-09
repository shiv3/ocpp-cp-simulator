/**
 * Scenarios that nest: the block-tree views' test fixtures (and the browser
 * check's imports). Ids say where a step sits.
 */
import type { Edge } from "@xyflow/react";

import {
  type ScenarioDefinition,
  type ScenarioNode,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

function n(
  id: string,
  type: ScenarioNodeType = ScenarioNodeType.DELAY,
  data: Record<string, unknown> = { delaySeconds: 1 },
): ScenarioNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, ...data } as ScenarioNode["data"],
  };
}

const START = () => n("start", ScenarioNodeType.START, {});
const END = () => n("end", ScenarioNodeType.END, {});
const sw = (id: string, cases: unknown[], value: unknown = "a") =>
  n(id, ScenarioNodeType.SWITCH, { value, cases });
const choice = (id: string, weights: number[]) =>
  n(id, ScenarioNodeType.CHOICE, {
    options: weights.map((weight, i) => ({ weight, label: `o${i}` })),
  });

function def(
  id: string,
  nodes: ScenarioNode[],
  pairs: Array<[string, string] | [string, string, string]>,
): ScenarioDefinition {
  const edges: Edge[] = pairs.map(([source, target, handle]) => ({
    id: `${source}->${target}${handle ? `:${handle}` : ""}`,
    source,
    target,
    ...(handle !== undefined ? { sourceHandle: handle } : {}),
  }));
  return {
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    nodes,
    edges,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as ScenarioDefinition;
}

/** START → route (switch) ┬ case-0 → a → inner (switch) ┬ case-0 → x → END
 *                         │                            └ default → y → END
 *                         └ default → b → END */
export const switchInLane = () =>
  def(
    "switch-in-lane",
    [
      START(),
      sw("route", ["Accepted"], "Accepted"),
      n("a"),
      sw("inner", ["Charging"]),
      n("x"),
      n("y"),
      n("b"),
      END(),
    ],
    [
      ["start", "route"],
      ["route", "a", "case-0"],
      ["route", "b", "default"],
      ["a", "inner"],
      ["inner", "x", "case-0"],
      ["inner", "y", "default"],
      ["x", "end"],
      ["y", "end"],
      ["b", "end"],
    ],
  );

/** START → pre → check (switch) ┬ case-0 → ok ┐
 *                               └ default → ko ┴ merge → after → END */
export const ifElseReconverges = () =>
  def(
    "if-else",
    [
      START(),
      n("pre"),
      sw("check", ["Accepted"]),
      n("ok"),
      n("ko"),
      n("merge"),
      n("after"),
      END(),
    ],
    [
      ["start", "pre"],
      ["pre", "check"],
      ["check", "ok", "case-0"],
      ["check", "ko", "default"],
      ["ok", "merge"],
      ["ko", "merge"],
      ["merge", "after"],
      ["after", "end"],
    ],
  );

/** START → first → head → pick (switch) ┬ case-0 → again → head (loop)
 *                                       └ default → out → END (leaves) */
export const loopWithSwitch = () =>
  def(
    "loop-switch",
    [
      START(),
      n("first"),
      n("head"),
      sw("pick", ["more"]),
      n("again"),
      n("out"),
      END(),
    ],
    [
      ["start", "first"],
      ["first", "head"],
      ["head", "pick"],
      ["pick", "again", "case-0"],
      ["pick", "out", "default"],
      ["again", "head"],
      ["out", "end"],
    ],
  );

/** START ┬ l0a → l0b → back to l0a (a loop in lane 0)
 *        └ l1 → odds (choice) ┬ option-0 → c0 → END
 *                             └ option-1 → c1 → END */
export const startFanOutWithLoop = () =>
  def(
    "fan-out-loop",
    [
      START(),
      n("l0a"),
      n("l0b"),
      n("l1"),
      choice("odds", [3, 7]),
      n("c0"),
      n("c1"),
      END(),
    ],
    [
      ["start", "l0a"],
      ["start", "l1"],
      ["l0a", "l0b"],
      ["l0b", "l0a"],
      ["l1", "odds"],
      ["odds", "c0", "option-0"],
      ["odds", "c1", "option-1"],
      ["c0", "end"],
      ["c1", "end"],
    ],
  );

/** START → s1 → s2 → END, and an island i1 → i2 nothing reaches. */
export const withDetached = () =>
  def(
    "detached",
    [START(), n("s1"), n("s2"), n("i1"), n("i2"), END()],
    [
      ["start", "s1"],
      ["s1", "s2"],
      ["s2", "end"],
      ["i1", "i2"],
    ],
  );

/** START → loopHead → inner (switch) ┬ case-0 → p → loopHead
 *                                    └ default → q → loopHead
 *  A loop whose body forks; both lanes come back. */
export const forkInLoop = () =>
  def(
    "fork-in-loop",
    [START(), n("loopHead"), sw("inner", ["x"]), n("p"), n("q"), END()],
    [
      ["start", "loopHead"],
      ["loopHead", "inner"],
      ["inner", "p", "case-0"],
      ["inner", "q", "default"],
      ["p", "loopHead"],
      ["q", "loopHead"],
    ],
  );

/** START → route (switch, cases ["a"]) ┬ case-0 → hit → END
 *                                       ├ default → miss → END
 *                                       ├ case-0 (again) → dup → END (ignored)
 *                                       └ case-7 → never → END (unpickable) */
export const deadLanes = () =>
  def(
    "dead-lanes",
    [
      START(),
      sw("route", ["a"]),
      n("hit"),
      n("miss"),
      n("dup"),
      n("never"),
      END(),
    ],
    [
      ["start", "route"],
      ["route", "hit", "case-0"],
      ["route", "miss", "default"],
      ["route", "dup", "case-0"],
      ["route", "never", "case-7"],
      ["hit", "end"],
      ["miss", "end"],
      ["dup", "end"],
      ["never", "end"],
    ],
  );

/** START → first → head → pick (switch ["more", "stop"])
 *    ┬ case-0 → again → head (loops)
 *    ├ case-1 → out → END (the loop's way on, after it)
 *    └ default → bye → END (a second way out: its lane leaves the loop) */
export const loopWithTwoExits = () =>
  def(
    "loop-two-exits",
    [
      START(),
      n("first"),
      n("head"),
      sw("pick", ["more", "stop"]),
      n("again"),
      n("out"),
      n("bye"),
      END(),
    ],
    [
      ["start", "first"],
      ["first", "head"],
      ["head", "pick"],
      ["pick", "again", "case-0"],
      ["pick", "out", "case-1"],
      ["pick", "bye", "default"],
      ["again", "head"],
      ["out", "end"],
      ["bye", "end"],
    ],
  );

/** START ┬ x1 → x2 → END
 *        └ y1 → f (switch) ┬ case-0 → a1 → x1 (a join into the lane on
 *                          │   the left: a jump)
 *                          └ default → END */
export const joinIntoLeftLane = () =>
  def(
    "join-left",
    [START(), n("x1"), n("x2"), n("y1"), sw("f", ["m"]), n("a1"), END()],
    [
      ["start", "x1"],
      ["start", "y1"],
      ["x1", "x2"],
      ["x2", "end"],
      ["y1", "f"],
      ["f", "a1", "case-0"],
      ["a1", "x1"],
      ["f", "end", "default"],
    ],
  );

/** START ┬ p → END
 *        └ q → START (an edge back into a START that fans out) */
export const intoStartFanOut = () =>
  def(
    "into-start",
    [START(), n("p"), n("q"), END()],
    [
      ["start", "p"],
      ["start", "q"],
      ["p", "end"],
      ["q", "start"],
    ],
  );

/** START → head → f1 (switch ["m", "n"])
 *    ┬ default → out → END (the loop's way on)
 *    ├ case-0 → head (loops)
 *    └ case-1 → f2 (switch) ┬ case-0 → x → head (loops)
 *                           └ default → bye → END (leaves the loop, two
 *                             forks deep) */
export const deepLeavingLane = () =>
  def(
    "deep-leaving",
    [
      START(),
      n("head"),
      sw("f1", ["m", "n"]),
      sw("f2", ["m"]),
      n("x"),
      n("bye"),
      n("out"),
      END(),
    ],
    [
      ["start", "head"],
      ["head", "f1"],
      ["f1", "out", "default"],
      ["f1", "head", "case-0"],
      ["f1", "f2", "case-1"],
      ["f2", "x", "case-0"],
      ["x", "head"],
      ["f2", "bye", "default"],
      ["bye", "end"],
      ["out", "end"],
    ],
  );

export const NESTED_FIXTURES = {
  switchInLane,
  ifElseReconverges,
  loopWithSwitch,
  loopWithTwoExits,
  startFanOutWithLoop,
  withDetached,
  forkInLoop,
  deadLanes,
  joinIntoLeftLane,
  intoStartFanOut,
  deepLeavingLane,
};
