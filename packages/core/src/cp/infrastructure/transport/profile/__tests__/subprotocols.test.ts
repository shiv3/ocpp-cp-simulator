import { describe, expect, it } from "vitest";

import { checkSelectedSubprotocol } from "../subprotocols";

describe("checkSelectedSubprotocol (#1061)", () => {
  it("accepts a selection that was offered", () => {
    expect(checkSelectedSubprotocol(["ocpp1.6"], "ocpp1.6")).toEqual({
      kind: "matched",
    });
    expect(
      checkSelectedSubprotocol(["ocpp2.1", "ocpp2.0.1"], "ocpp2.0.1"),
    ).toEqual({ kind: "matched" });
  });

  it("reports an absent selection", () => {
    const result = checkSelectedSubprotocol(["ocpp1.6"], "");
    expect(result.kind).toBe("missing");
    expect("message" in result && result.message).toContain("ocpp1.6");
  });

  it("reports a selection that was not offered, case-sensitively", () => {
    const other = checkSelectedSubprotocol(["ocpp1.6"], "ocpp2.0.1");
    expect(other.kind).toBe("mismatch");
    expect("message" in other && other.message).toContain('"ocpp2.0.1"');
    expect(checkSelectedSubprotocol(["ocpp1.6"], "OCPP1.6").kind).toBe(
      "mismatch",
    );
  });

  it("expects no selection when nothing was offered", () => {
    expect(checkSelectedSubprotocol([], "")).toEqual({ kind: "none-offered" });
  });
});
