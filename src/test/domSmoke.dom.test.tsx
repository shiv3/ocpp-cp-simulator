import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

function DomSmoke() {
  return <h1>Scenario editor DOM smoke</h1>;
}

describe("DOM test setup", () => {
  it("renders React components with Testing Library matchers", () => {
    render(<DomSmoke />);

    expect(
      screen.getByRole("heading", { name: "Scenario editor DOM smoke" }),
    ).toBeInTheDocument();
  });
});
