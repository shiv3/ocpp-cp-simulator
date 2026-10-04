import { afterEach, describe, expect, it, vi } from "vitest";

import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import type { ChargePointService } from "../../data/interfaces/ChargePointService";
import { createScenarioStore } from "../test/scenarioStore";
import {
  LIBRARY_SCOPE,
  assignLibraryScenario,
  deleteLibraryScenario,
  editScenarioUrl,
  libraryCopyId,
  migrateToLibrary,
  runsOfLibraryScenario,
  saveLibraryScenario,
  toLibraryScenario,
  usedBy,
} from "./scenarioLibrary";
import { createEmptyScenario } from "./scenarioSteps";
import type { ScenarioLibraryItem } from "./useAllScenarios";
import type { ChargePointRun } from "./useAllActiveScenarioRuns";

const NOW = "2026-10-04T10:00:00.000Z";

function libraryEntry(
  id: string,
  overrides: Partial<ScenarioDefinition> = {},
): ScenarioDefinition {
  return {
    ...createEmptyScenario(`Scenario ${id}`, "connector"),
    id,
    ...overrides,
  };
}

function serviceWith(store = createScenarioStore()) {
  return {
    store,
    service: store.methods as unknown as ChargePointService,
  };
}

function item(
  cpId: string,
  connectorId: number | null,
  scenario: ScenarioDefinition,
): ScenarioLibraryItem {
  return { cpId, connectorId, scenario };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assignLibraryScenario", () => {
  it("replaces the connector's set with one tagged copy under a deterministic id", async () => {
    const { store, service } = serviceWith();
    store.set("CP-1", 1, [libraryEntry("old-one", { targetId: 1 })]);
    const lib = libraryEntry("lib-a", { description: "the A flow" });

    const copy = await assignLibraryScenario(service, "CP-1", 1, lib, NOW);

    expect(copy?.id).toBe(libraryCopyId("lib-a", "CP-1", 1));
    expect(copy?.id).toBe("lib-a@CP-1#1");
    expect(service.replaceConnectorScenarioDefinitions).toHaveBeenCalledWith(
      "CP-1",
      1,
      [
        expect.objectContaining({
          id: "lib-a@CP-1#1",
          libraryId: "lib-a",
          targetType: "connector",
          targetId: 1,
          description: "the A flow",
          updatedAt: NOW,
        }),
      ],
    );
    expect(store.get("CP-1", 1).map((d) => d.id)).toEqual(["lib-a@CP-1#1"]);

    // Assigning the same scenario again replaces the copy, it does not stack.
    await assignLibraryScenario(service, "CP-1", 1, lib, NOW);
    expect(store.get("CP-1", 1)).toHaveLength(1);
  });

  it("with null empties the connector's set", async () => {
    const { store, service } = serviceWith();
    store.set("CP-1", 2, [libraryEntry("x")]);

    const copy = await assignLibraryScenario(service, "CP-1", 2, null, NOW);

    expect(copy).toBeNull();
    expect(service.replaceConnectorScenarioDefinitions).toHaveBeenCalledWith(
      "CP-1",
      2,
      [],
    );
    expect(store.get("CP-1", 2)).toEqual([]);
  });
});

describe("usedBy and runsOfLibraryScenario", () => {
  const items = [
    item("CP-1", 1, { ...libraryEntry("a@CP-1#1"), libraryId: "a" }),
    item("CP-1", 2, { ...libraryEntry("b@CP-1#2"), libraryId: "b" }),
    item("CP-2", 1, { ...libraryEntry("a@CP-2#1"), libraryId: "a" }),
    item("CP-2", 2, libraryEntry("hand-loaded")),
    item(LIBRARY_SCOPE, null, libraryEntry("a")),
  ];

  it("lists every connector whose scope holds a copy of the scenario", () => {
    expect(usedBy(items, "a").map((i) => `${i.cpId}#${i.connectorId}`)).toEqual(
      ["CP-1#1", "CP-2#1"],
    );
    expect(usedBy(items, "b")).toHaveLength(1);
    expect(usedBy(items, "hand-loaded")).toEqual([]);
  });

  it("finds the live runs of the scenario's copies", () => {
    const run = (cpId: string, connectorId: number, scenarioId: string) =>
      ({ cpId, connectorId, scenarioId, state: "running" }) as ChargePointRun;
    const runs = [
      run("CP-1", 1, "a@CP-1#1"),
      run("CP-1", 2, "b@CP-1#2"),
      run("CP-2", 2, "hand-loaded"),
    ];

    expect(runsOfLibraryScenario(runs, items, "a")).toEqual([runs[0]]);
    expect(runsOfLibraryScenario(runs, items, "b")).toEqual([runs[1]]);
  });
});

describe("saveLibraryScenario", () => {
  it("saves the entry under the library scope and re-pushes the copy to every user", async () => {
    const { store, service } = serviceWith();
    const before = libraryEntry("lib-a");
    store.set(LIBRARY_SCOPE, null, [before]);
    await assignLibraryScenario(service, "CP-1", 1, before, NOW);
    await assignLibraryScenario(service, "CP-2", 3, before, NOW);
    // A migrated copy keeps its own id, and a sibling it shares the scope with.
    const sibling = libraryEntry("sibling", { targetId: 4 });
    const legacy = { ...libraryEntry("legacy-id"), libraryId: "lib-a" };
    store.set("CP-2", 4, [legacy, sibling]);
    const users = [
      item("CP-1", 1, store.get("CP-1", 1)[0]),
      item("CP-2", 3, store.get("CP-2", 3)[0]),
      item("CP-2", 4, legacy),
    ];
    vi.mocked(service.replaceConnectorScenarioDefinitions).mockClear();

    const edited = { ...before, name: "Renamed" };
    await saveLibraryScenario(service, edited, users, NOW);

    expect(service.saveScenarioDefinition).toHaveBeenCalledWith(
      LIBRARY_SCOPE,
      null,
      expect.objectContaining({ id: "lib-a", name: "Renamed" }),
    );
    expect(service.replaceConnectorScenarioDefinitions).toHaveBeenCalledTimes(
      3,
    );
    expect(store.get("CP-1", 1)).toEqual([
      expect.objectContaining({
        id: "lib-a@CP-1#1",
        libraryId: "lib-a",
        name: "Renamed",
        targetId: 1,
      }),
    ]);
    expect(store.get("CP-2", 3)[0]).toMatchObject({
      name: "Renamed",
      targetId: 3,
    });
    expect(store.get("CP-2", 4)).toEqual([
      expect.objectContaining({
        id: "legacy-id",
        name: "Renamed",
        libraryId: "lib-a",
      }),
      sibling,
    ]);
  });
});

describe("deleteLibraryScenario", () => {
  it("un-assigns every user, then deletes the entry", async () => {
    const { store, service } = serviceWith();
    const lib = libraryEntry("lib-a");
    store.set(LIBRARY_SCOPE, null, [lib]);
    await assignLibraryScenario(service, "CP-1", 1, lib, NOW);

    await deleteLibraryScenario(service, "lib-a", [
      item("CP-1", 1, store.get("CP-1", 1)[0]),
    ]);

    expect(store.get("CP-1", 1)).toEqual([]);
    expect(store.get(LIBRARY_SCOPE, null)).toEqual([]);
    expect(service.deleteScenarioDefinition).toHaveBeenCalledWith(
      LIBRARY_SCOPE,
      null,
      "lib-a",
    );
  });
});

describe("migrateToLibrary", () => {
  it("creates one library entry per distinct definition and tags the copies; a second run is a no-op", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { store, service } = serviceWith();
    const essential1 = {
      ...libraryEntry("ess-CP-1-c1"),
      name: "Essential",
      templateId: "essential-cp-behavior",
      targetId: 1,
    };
    const essential2 = {
      ...libraryEntry("ess-CP-1-c2"),
      name: "Essential (renamed)",
      templateId: "essential-cp-behavior",
      targetId: 2,
    };
    const custom = { ...libraryEntry("custom-1"), name: "Custom", targetId: 1 };
    store.set("CP-1", 1, [essential1, custom]);
    store.set("CP-1", 2, [essential2]);
    const items = [
      item("CP-1", 1, essential1),
      item("CP-1", 1, custom),
      item("CP-1", 2, essential2),
    ];
    let next = 0;
    const makeId = () => `lib-${++next}`;

    const result = await migrateToLibrary(service, [], items, {
      makeId,
      now: NOW,
    });

    expect(result.created.map((d) => d.name)).toEqual(["Essential", "Custom"]);
    const library = store.get(LIBRARY_SCOPE, null);
    expect(library).toHaveLength(2);
    for (const entry of library) {
      expect(entry.targetType).toBe("connector");
      expect(entry).not.toHaveProperty("targetId");
      expect(entry).not.toHaveProperty("libraryId");
    }
    const essentialId = result.created[0].id;
    // The copies keep their ids and gain the tag.
    expect(store.get("CP-1", 2)).toEqual([
      expect.objectContaining({ id: "ess-CP-1-c2", libraryId: essentialId }),
    ]);
    expect(
      store
        .get("CP-1", 1)
        .map((d) => [d.id, d.libraryId])
        .sort(),
    ).toEqual(
      [
        ["custom-1", result.created[1].id],
        ["ess-CP-1-c1", essentialId],
      ].sort(),
    );
    expect(result.tagged).toBe(3);

    vi.mocked(service.saveScenarioDefinition).mockClear();
    const again = await migrateToLibrary(service, library, items, {
      makeId,
      now: NOW,
    });
    expect(again).toEqual({ created: [], tagged: 0 });
    expect(service.saveScenarioDefinition).not.toHaveBeenCalled();
  });

  it("does nothing when no connector holds a definition", async () => {
    const { service } = serviceWith();
    const result = await migrateToLibrary(service, [], []);
    expect(result).toEqual({ created: [], tagged: 0 });
    expect(service.saveScenarioDefinition).not.toHaveBeenCalled();
  });
});

describe("toLibraryScenario and editScenarioUrl", () => {
  it("strips the connector target from an imported scenario", () => {
    const imported = {
      ...libraryEntry("imp"),
      targetType: "chargePoint" as const,
      targetId: 3,
      libraryId: "elsewhere",
    };
    const entry = toLibraryScenario(imported, NOW);
    expect(entry.targetType).toBe("connector");
    expect(entry).not.toHaveProperty("targetId");
    expect(entry).not.toHaveProperty("libraryId");
    expect(entry.updatedAt).toBe(NOW);
  });

  it("sends Edit to the library editor for a library entry or a copy, else to the per-connector editor", () => {
    expect(editScenarioUrl(LIBRARY_SCOPE, null, { id: "lib-a" })).toBe(
      "/scenarios?tab=library&edit=lib-a",
    );
    expect(
      editScenarioUrl("CP-1", 1, { id: "lib-a@CP-1#1", libraryId: "lib-a" }),
    ).toBe("/scenarios?tab=library&edit=lib-a");
    expect(editScenarioUrl("CP-1", 1, { id: "s1" })).toBe(
      "/scenarios/edit?cp=CP-1&connector=1&id=s1",
    );
  });
});
