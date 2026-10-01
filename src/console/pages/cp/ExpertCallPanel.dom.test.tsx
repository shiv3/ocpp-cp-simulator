// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DataContext } from "@/data/providers/DataProvider";
import { getOcppCallCatalog } from "@/cp/infrastructure/transport/codec/ocppCallCatalog";
import {
  createFakeChargePointService,
  flush,
  type FakeChargePointService,
} from "../../test/harness";
import ExpertCallPanel from "./ExpertCallPanel";

let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  document.body.innerHTML = "";
});

type PanelProps = { ocppVersion?: string; connected?: boolean };

function panel(service: FakeChargePointService, props: PanelProps) {
  return (
    <DataContext.Provider
      value={{
        mode: "remote",
        serverUrl: "http://test",
        defaultEvSettings: null,
        setDefaultEvSettings: () => {},
        chargePointService: service,
      }}
    >
      <ExpertCallPanel
        cpId="CP-1"
        ocppVersion={props.ocppVersion ?? "OCPP-1.6J"}
        connected={props.connected ?? true}
      />
    </DataContext.Provider>
  );
}

async function renderPanel(
  service: FakeChargePointService,
  props: PanelProps = {},
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(panel(service, props)));
  return container;
}

async function rerenderPanel(
  service: FakeChargePointService,
  ocppVersion: string,
): Promise<void> {
  await act(async () => root!.render(panel(service, { ocppVersion })));
}

/** Drive a controlled field the way React's synthetic onChange expects. */
function setValue(
  field: HTMLTextAreaElement | HTMLSelectElement,
  next: string,
): void {
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, next);
  field.dispatchEvent(
    new Event(field instanceof HTMLSelectElement ? "change" : "input", {
      bubbles: true,
    }),
  );
}

const actionSelect = (c: HTMLElement) =>
  c.querySelector<HTMLSelectElement>('select[aria-label="Action"]')!;
const payloadArea = (c: HTMLElement) =>
  c.querySelector<HTMLTextAreaElement>('textarea[aria-label="Payload"]')!;
const checkbox = (c: HTMLElement, name: string) =>
  c.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const sendButton = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Send",
  )!;

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

async function choose(c: HTMLElement, action: string): Promise<void> {
  await act(async () => setValue(actionSelect(c), action));
}

async function type(c: HTMLElement, payload: string): Promise<void> {
  await act(async () => setValue(payloadArea(c), payload));
}

describe("ExpertCallPanel (#389)", () => {
  it("offers the version's station calls and starts each from its default payload", async () => {
    const c = await renderPanel(createFakeChargePointService());
    const catalog = getOcppCallCatalog("OCPP-1.6J")!;

    const options = Array.from(actionSelect(c).options).map((o) => o.value);
    expect(options).toEqual([...catalog.actions]);

    await choose(c, "StatusNotification");
    expect(JSON.parse(payloadArea(c).value)).toEqual(
      catalog.defaultPayload("StatusNotification"),
    );
  });

  it("sends the edited payload and shows the frame sent and the CALLRESULT", async () => {
    const sendOcppCall = vi.fn(async () => ({
      kind: "callResult" as const,
      messageId: "m1",
      sentFrame: '[2,"m1","DataTransfer",{"vendorId":"acme"}]',
      payload: { status: "Accepted" },
    }));
    const service = createFakeChargePointService({ sendOcppCall });
    const c = await renderPanel(service);

    await choose(c, "DataTransfer");
    await type(c, '{"vendorId":"acme"}');
    await click(sendButton(c));

    expect(sendOcppCall).toHaveBeenCalledWith("CP-1", {
      action: "DataTransfer",
      payload: { vendorId: "acme" },
      skipValidation: false,
      applyResponse: false,
    });
    expect(c.textContent).toContain(
      '[2,"m1","DataTransfer",{"vendorId":"acme"}]',
    );
    expect(c.textContent).toContain("CALLRESULT");
    expect(c.textContent).toContain('"status": "Accepted"');
  });

  it("shows a CALLERROR with its code and description", async () => {
    const sendOcppCall = vi.fn(async () => ({
      kind: "callError" as const,
      messageId: "m1",
      sentFrame: '[2,"m1","Heartbeat",{}]',
      errorCode: "NotImplemented",
      errorDescription: "nope",
      errorDetails: {},
    }));
    const c = await renderPanel(createFakeChargePointService({ sendOcppCall }));

    await choose(c, "Heartbeat");
    await click(sendButton(c));

    expect(c.textContent).toContain("CALLERROR NotImplemented");
    expect(c.textContent).toContain("nope");
  });

  it("blocks a schema-invalid payload until the expert skip is ticked", async () => {
    const sendOcppCall = vi.fn(async () => ({
      kind: "callResult" as const,
      messageId: "m1",
      sentFrame: "[]",
      payload: {},
    }));
    const c = await renderPanel(createFakeChargePointService({ sendOcppCall }));

    await choose(c, "Heartbeat");
    await type(c, '{"unexpected":true}');
    expect(c.textContent).toContain("failed v16 schema validation");
    expect(sendButton(c).disabled).toBe(true);

    await click(checkbox(c, "skipValidation"));
    await click(checkbox(c, "applyResponse"));
    expect(sendButton(c).disabled).toBe(false);
    await click(sendButton(c));

    expect(sendOcppCall).toHaveBeenCalledWith("CP-1", {
      action: "Heartbeat",
      payload: { unexpected: true },
      skipValidation: true,
      applyResponse: true,
    });
  });

  it("does not send JSON that is not an object, even with the skip ticked", async () => {
    const c = await renderPanel(createFakeChargePointService());
    await choose(c, "Heartbeat");
    await click(checkbox(c, "skipValidation"));
    await type(c, "{not json");
    expect(c.textContent).toContain("Payload is not valid JSON");
    expect(sendButton(c).disabled).toBe(true);
    await type(c, "[1]");
    expect(c.textContent).toContain("must be a JSON object");
    expect(sendButton(c).disabled).toBe(true);
  });

  it("shows why the call was refused", async () => {
    const sendOcppCall = vi.fn(async () => {
      throw new Error("blocked by the boot gate");
    });
    const c = await renderPanel(createFakeChargePointService({ sendOcppCall }));
    await choose(c, "Heartbeat");
    await click(sendButton(c));
    expect(c.textContent).toContain("blocked by the boot gate");
  });

  it("cannot send while disconnected", async () => {
    const c = await renderPanel(createFakeChargePointService(), {
      connected: false,
    });
    expect(sendButton(c).disabled).toBe(true);
  });

  it("starts over when the CP's OCPP version becomes known or changes", async () => {
    const service = createFakeChargePointService();
    const c = await renderPanel(service, { ocppVersion: "" });
    expect(c.textContent).toContain("OCPP version unknown");

    await rerenderPanel(service, "OCPP-2.0.1");
    expect(actionSelect(c).value).toBe("Heartbeat");
    expect(Array.from(actionSelect(c).options).map((o) => o.value)).toContain(
      "TransactionEvent",
    );
    await choose(c, "StatusNotification");

    await rerenderPanel(service, "OCPP-1.6J");
    expect(actionSelect(c).value).toBe("Heartbeat");
    expect(payloadArea(c).value).toBe("{}");
  });

  it("explains that SOAP stations have no expert calls", async () => {
    const c = await renderPanel(createFakeChargePointService(), {
      ocppVersion: "OCPP-1.6S",
    });
    expect(c.querySelector("select")).toBeNull();
    expect(c.textContent).toContain("not available over SOAP");
  });
});
