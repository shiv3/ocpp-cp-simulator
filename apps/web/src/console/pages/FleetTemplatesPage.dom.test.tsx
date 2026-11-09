// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  FleetCreateResult,
  FleetTemplate,
} from "@ocpp-cp-simulator/contracts/methods";
import {
  createFakeChargePointService,
  flush,
  renderConsole,
} from "../test/harness";

// #445: the fleet template screen over fleet.template.* and fleet.create.

const LAB: FleetTemplate = {
  id: "operations-lab",
  name: "Operations lab",
  description: "Two sites",
  labels: { env: "lab" },
  groups: [
    {
      name: "site-a",
      labels: { site: "a" },
      members: [
        { cpId: "CP001", blueprintId: "ac-22kw" },
        {
          cpId: "CP002",
          blueprintId: "ac-22kw",
          scenarioTemplateId: "full-charging-cycle",
        },
      ],
    },
    {
      name: "site-b",
      members: [
        {
          idPattern: "DC{n:03}",
          count: 3,
          startIndex: 4,
          blueprintId: "dc-150kw",
          evSettings: { maxChargingPowerKw: 60 },
        },
      ],
    },
  ],
};

const body = () => document.body;
const button = (label: string, within: ParentNode = body()) =>
  Array.from(within.querySelectorAll("button")).find(
    (b) =>
      b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );

const dialogButton = (label: string) =>
  button(label, body().querySelector('[role="dialog"]')!);

async function click(target: HTMLElement | undefined): Promise<void> {
  expect(target).toBeTruthy();
  await act(async () => target!.click());
  await flush();
}

async function type(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Fleet templates page (#445)", () => {
  let root: Root | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  async function open(
    overrides: Parameters<typeof createFakeChargePointService>[0] = {},
    mode: "local" | "remote" = "remote",
  ) {
    const service = createFakeChargePointService({
      listFleetTemplates: vi.fn(async () => [LAB]),
      getFleetTemplate: vi.fn(async () => LAB),
      ...overrides,
    });
    ({ root } = await renderConsole("/fleets", { service, mode }));
    await flush();
    // Not the proxy itself: a returned thenable would be awaited.
    return { service };
  }

  it("lists the templates with their group and charge point counts", async () => {
    await open();
    const row = body().querySelector('[data-template="operations-lab"]')!;
    expect(row.textContent).toContain("Operations lab");
    expect(row.textContent).toContain("2 groups");
    // 2 single charge points + a range of 3
    expect(row.textContent).toContain("5 charge points");
  });

  it("is reachable from the sidebar", async () => {
    await open();
    const link = Array.from(body().querySelectorAll("aside a")).find(
      (a) => a.getAttribute("href") === "/fleets",
    );
    expect(link?.textContent).toBe("Fleet templates");
    expect(link?.getAttribute("aria-current")).toBe("page");
  });

  it("views a template as groups and member lines, ids only", async () => {
    const { service } = await open();
    await click(button("View Operations lab"));
    expect(service.getFleetTemplate).toHaveBeenCalledWith("operations-lab");
    const detail = body().querySelector('[data-group="site-b"]')!;
    expect(detail.textContent).toContain("DC{n:03} × 3");
    expect(detail.textContent).toContain("dc-150kw");
    expect(detail.textContent).toContain("EV settings");
    expect(
      body().querySelector('[data-group="site-a"]')!.textContent,
    ).toContain("full-charging-cycle");
    // a second press hides it again
    await click(button("View Operations lab"));
    expect(body().querySelector('[data-group="site-a"]')).toBeNull();
  });

  it("saves a new template from valid JSON and reloads the list", async () => {
    const saved: FleetTemplate[] = [];
    const list = vi
      .fn<() => Promise<FleetTemplate[]>>()
      .mockResolvedValueOnce([])
      .mockImplementation(async () => saved);
    const { service } = await open({
      listFleetTemplates: list,
      saveFleetTemplate: vi.fn(async (template: FleetTemplate) => {
        saved.push(template);
        return template.id;
      }),
    });
    expect(body().textContent).toContain("No fleet templates");
    await click(button("New template"));
    const editor = body().querySelector<HTMLTextAreaElement>("textarea")!;
    await type(
      editor,
      JSON.stringify({
        id: "mine",
        name: "Mine",
        groups: [
          { name: "g", members: [{ cpId: "X1", blueprintId: "ac-22kw" }] },
        ],
      }),
    );
    await click(button("Save"));
    expect(service.saveFleetTemplate).toHaveBeenCalledWith({
      id: "mine",
      name: "Mine",
      groups: [
        { name: "g", members: [{ cpId: "X1", blueprintId: "ac-22kw" }] },
      ],
    });
    expect(body().querySelector("textarea")).toBeNull();
    expect(body().querySelector('[data-template="mine"]')).not.toBeNull();
  });

  it("refuses invalid JSON and invalid templates before calling the daemon", async () => {
    const { service } = await open();
    await click(button("New template"));
    const editor = body().querySelector<HTMLTextAreaElement>("textarea")!;
    await type(editor, "{ nope");
    await click(button("Save"));
    expect(body().querySelector('[role="alert"]')).not.toBeNull();
    await type(
      editor,
      JSON.stringify({
        id: "x",
        name: "X",
        groups: [{ name: "g", members: [{ blueprintId: "ac-22kw" }] }],
      }),
    );
    await click(button("Save"));
    expect(body().querySelector('[role="alert"]')!.textContent).toContain(
      "exactly one of cpId or idPattern",
    );
    expect(service.saveFleetTemplate).not.toHaveBeenCalled();
  });

  it("shows what the daemon refuses and keeps the editor open", async () => {
    await open({
      saveFleetTemplate: vi.fn(async () => {
        throw new Error(
          '"operations-lab" comes from a --fleet-template file and cannot be replaced',
        );
      }),
    });
    await click(button("Edit Operations lab"));
    const editor = body().querySelector<HTMLTextAreaElement>("textarea")!;
    expect(JSON.parse(editor.value)).toEqual(LAB);
    await click(button("Save"));
    expect(body().querySelector('[role="alert"]')!.textContent).toContain(
      "cannot be replaced",
    );
    expect(body().querySelector("textarea")).not.toBeNull();
  });

  it("deletes after a confirmation, and keeps the template on 'Keep'", async () => {
    const list = vi
      .fn<() => Promise<FleetTemplate[]>>()
      .mockResolvedValueOnce([LAB])
      .mockResolvedValue([]);
    const { service } = await open({
      listFleetTemplates: list,
      deleteFleetTemplate: vi.fn(async () => {}),
    });
    await click(button("Delete Operations lab"));
    await click(button("Keep"));
    expect(service.deleteFleetTemplate).not.toHaveBeenCalled();
    await click(button("Delete Operations lab"));
    await click(
      body().querySelector<HTMLElement>(
        '[role="alertdialog"] button:last-child',
      )!,
    );
    expect(service.deleteFleetTemplate).toHaveBeenCalledWith("operations-lab");
    expect(body().querySelector('[data-template="operations-lab"]')).toBeNull();
  });

  it("creates a fleet with the options given and lists the created ids", async () => {
    const result: FleetCreateResult = {
      templateId: "operations-lab",
      created: ["t-CP001", "t-CP002"],
      failed: [],
    };
    const { service } = await open({ createFleet: vi.fn(async () => result) });
    await click(button("Create a fleet from Operations lab"));
    const inputs = body().querySelectorAll<HTMLInputElement>(
      'input:not([type="checkbox"])',
    );
    await type(inputs[0]!, "ws://csms.test/ocpp");
    await type(inputs[1]!, "t-");
    await click(body().querySelector<HTMLElement>('[role="switch"]')!);
    await click(dialogButton("Create fleet"));
    expect(service.createFleet).toHaveBeenCalledWith({
      templateId: "operations-lab",
      wsUrl: "ws://csms.test/ocpp",
      idPrefix: "t-",
      autoConnect: true,
    });
    const status = body().querySelector('[role="dialog"] [role="status"]')!;
    expect(status.textContent).toContain("Created 2 charge points.");
    expect(status.textContent).toContain("t-CP001, t-CP002");
    expect(body().querySelector('[role="alert"]')).toBeNull();
  });

  it("reports a partial failure with each reason, in order", async () => {
    const { service } = await open({
      createFleet: vi.fn(async () => ({
        templateId: "operations-lab",
        created: ["CP001"],
        failed: [
          { cpId: "CP002", reason: "cpId already registered" },
          { cpId: "DC004", reason: "boom" },
        ],
      })),
    });
    await click(button("Create a fleet from Operations lab"));
    await click(dialogButton("Create fleet"));
    expect(service.createFleet).toHaveBeenCalledWith({
      templateId: "operations-lab",
    });
    const alert = body().querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("2 charge points were not created");
    const items = Array.from(alert.querySelectorAll("li")).map(
      (li) => li.textContent,
    );
    expect(items).toEqual(["CP002: cpId already registered", "DC004: boom"]);
  });

  it("shows a call that fails as an error and lets the operator retry", async () => {
    await open({
      createFleet: vi.fn(async () => {
        throw new Error('no blueprint "nope"');
      }),
    });
    await click(button("Create a fleet from Operations lab"));
    await click(dialogButton("Create fleet"));
    expect(body().querySelector('[role="alert"]')!.textContent).toContain(
      'no blueprint "nope"',
    );
    expect(dialogButton("Create fleet")).toBeTruthy();
  });

  it("shows a load error", async () => {
    await open({
      listFleetTemplates: vi.fn(async () => {
        throw new Error("rpc timed out");
      }),
    });
    expect(body().querySelector('[role="alert"]')!.textContent).toBe(
      "rpc timed out",
    );
  });

  it("says a daemon is needed in local mode and calls nothing", async () => {
    const { service } = await open({}, "local");
    expect(body().textContent).toContain("Fleet templates need a daemon");
    expect(service.listFleetTemplates).not.toHaveBeenCalled();
  });
});
