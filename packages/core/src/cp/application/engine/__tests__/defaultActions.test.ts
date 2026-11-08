import { describe, expect, it } from "vitest";
import { describeDefaultBehaviors } from "../behaviors";
import { DEFAULT_ACTIONS } from "../behaviors/defaultActions";

describe("DEFAULT_ACTIONS", () => {
  it("is the set of actions the default behaviors answer", () => {
    const actions = describeDefaultBehaviors().flatMap((b) => b.actions);
    expect([...DEFAULT_ACTIONS].sort()).toEqual([...actions].sort());
  });
  it("names nine behaviors, each with a default. id", () => {
    const list = describeDefaultBehaviors();
    expect(list).toHaveLength(9);
    for (const b of list) expect(b.id.startsWith("default.")).toBe(true);
  });
});
