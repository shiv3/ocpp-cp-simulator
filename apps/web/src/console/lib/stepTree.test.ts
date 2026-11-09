import { describe, expect, it } from "vitest";

import { recognizeBlockTree, type ForkBlock } from "./blockTree";
import {
  branchCount,
  conditionText,
  forkSummary,
  formatValue,
  lanesLeavingLoop,
  stepNumbers,
} from "./stepTree";
import {
  deadLanes,
  forkInLoop,
  ifElseReconverges,
  loopWithSwitch,
  startFanOutWithLoop,
  withDetached,
} from "../test/treeFixtures";

const firstFork = (seq: { blocks: unknown[] }): ForkBlock =>
  seq.blocks.find((b) => (b as { kind: string }).kind === "fork") as ForkBlock;

describe("stepTree", () => {
  it("formats switch values: $from paths, strings, numbers", () => {
    expect(formatValue({ $from: "call.idTag" })).toBe("$from: call.idTag");
    expect(formatValue("a")).toBe('"a"');
    expect(formatValue(3)).toBe("3");
    expect(formatValue(undefined)).toBe("?");
  });

  it("writes a $match case on a lane chip as a short text (schema 1.7)", () => {
    expect(
      conditionText({
        kind: "case",
        index: 1,
        value: { $match: { in: ["Blocked", "Invalid", "Expired"] } },
      }),
    ).toBe("case-1 → in Blocked|Invalid|Expired");
    expect(formatValue({ $match: { gte: 80 } })).toBe("≥ 80");
    expect(formatValue({ $match: { exists: false } })).toBe("missing");
    // An object with other keys beside $match is a plain constant.
    expect(formatValue({ $match: { gte: 80 }, x: 1 })).toBe(
      '{"$match":{"gte":80},"x":1}',
    );
  });

  it("numbers steps in pre-order, detached last, START left out", () => {
    const numbers = stepNumbers(recognizeBlockTree(ifElseReconverges()));
    expect([...numbers]).toEqual([
      ["pre", 1],
      ["check", 2],
      ["ok", 3],
      ["ko", 4],
      ["merge", 5],
      ["after", 6],
    ]);
    const detached = stepNumbers(recognizeBlockTree(withDetached()));
    expect(detached.get("i1")).toBe(3);
    expect(detached.has("start")).toBe(false);
  });

  it("says each lane's condition and each fork's kind", () => {
    const tree = recognizeBlockTree(deadLanes());
    const fork = firstFork(tree.root);
    expect(fork.lanes.map((l) => conditionText(l.condition, fork))).toEqual([
      'case-0 → "a"',
      "default",
      "ignored",
      "unpickable: case-7",
    ]);
    expect(forkSummary(fork)).toBe('Switch on "a"');
    const fan = firstFork(recognizeBlockTree(startFanOutWithLoop()).root);
    expect(forkSummary(fan)).toBe("Start: all run");
    const odds = firstFork(fan.lanes[1].body);
    expect(odds.lanes.map((l) => conditionText(l.condition, odds))).toEqual([
      'option-0 · 30% · "o0"',
      'option-1 · 70% · "o1"',
    ]);
  });

  it("finds the lanes that leave a loop (and none when every lane comes back)", () => {
    const tree = recognizeBlockTree(loopWithSwitch());
    const loop = tree.root.blocks[1];
    if (loop.kind !== "loop") throw new Error("expected a loop");
    expect([...lanesLeavingLoop(firstFork(loop.body), loop.headerId)]).toEqual([
      1,
    ]);
    const back = recognizeBlockTree(forkInLoop()).root.blocks[0];
    if (back.kind !== "loop") throw new Error("expected a loop");
    expect(lanesLeavingLoop(firstFork(back.body), back.headerId).size).toBe(0);
  });

  it("counts the lanes that run of branch points that pick or fan out", () => {
    expect(branchCount(recognizeBlockTree(deadLanes()))).toBe(2);
    expect(branchCount(recognizeBlockTree(startFanOutWithLoop()))).toBe(4);
    expect(branchCount(recognizeBlockTree(withDetached()))).toBe(0);
  });
});
