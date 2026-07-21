import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockCsms } from "../../../cp/infrastructure/transport/__tests__/mockCsms";
import { CLIChargePointService } from "../../service";
import { runStartupScenario } from "../startServer";

/**
 * Issue #214: import-time schema validation is advisory (WARNING-ONLY) —
 * a scenario file that fails `schema/scenario.schema.json` must still load
 * and run exactly as before, just with a stderr warning. This exercises the
 * real `runStartupScenario` entry point (the `--scenario-template-file`
 * path, `src/cli/server/startServer.ts`) against a real mock CSMS, mirroring
 * `startupScenarioBootGate.bun.test.ts`'s harness.
 *
 * The fixture's schema violation is `targetId` being a string instead of a
 * number at the template root — deliberately chosen because
 * `instantiateTemplate` overwrites `targetId` with the real connector id
 * before the scenario is ever loaded/run, so the violation cannot affect
 * runtime behavior; only the RAW template (as read from disk) is what gets
 * schema-checked and warned about.
 */
describe("CLI startup-scenario schema warning (issue #214, advisory only)", () => {
  it("warns to stderr but still loads and runs a schema-invalid --scenario-template-file", async () => {
    const csms = startMockCsms();
    const svc = new CLIChargePointService({
      cpId: "cp214",
      wsUrl: csms.url,
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-scenario-schema-warn-"));
    const templateFile = join(tmpDir, "invalid-schema-template.json");
    writeFileSync(
      templateFile,
      JSON.stringify({
        id: "schema-invalid-template",
        name: "Schema invalid template",
        targetType: "connector",
        // Schema requires targetId: number — a string is a schema
        // violation, but instantiateTemplate overwrites it per-connector
        // before this ever reaches loadScenario/runScenario.
        targetId: "not-a-number",
        trigger: { type: "manual" },
        nodes: [
          {
            id: "start",
            type: "start",
            position: { x: 0, y: 0 },
            data: { label: "Start" },
          },
          {
            id: "end",
            type: "end",
            position: { x: 0, y: 100 },
            data: { label: "End" },
          },
        ],
        edges: [{ id: "e1", source: "start", target: "end" }],
      }),
    );

    const stderrLines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrLines.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      await svc.connect();
      const boot = await csms.waitForCall("BootNotification");

      const runPromise = runStartupScenario(
        svc,
        {
          scenario: null,
          scenarioTemplate: null,
          scenarioTemplateFile: templateFile,
          scenarioConnector: "1",
        },
        1,
      );

      csms.replyCallResult(boot.messageId, {
        currentTime: new Date().toISOString(),
        interval: 300,
        status: "Accepted",
      });

      await runPromise;

      const warning = stderrLines.find((line) =>
        line.includes("schema/scenario.schema.json"),
      );
      expect(warning).toBeDefined();
      expect(warning).toContain(templateFile);
      expect(warning).toContain("targetId");

      // Still loaded and started despite the warning — advisory, never a gate.
      const applied = stderrLines.find(
        (line) =>
          line.includes("Scenario template file") && line.includes("applied"),
      );
      expect(applied).toBeDefined();

      const scenarios = svc.listScenarios(1);
      expect(
        scenarios.some((s) => s.name?.includes("Schema invalid template")),
      ).toBe(true);
    } finally {
      process.stderr.write = realWrite;
      svc.disconnect();
      await csms.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
