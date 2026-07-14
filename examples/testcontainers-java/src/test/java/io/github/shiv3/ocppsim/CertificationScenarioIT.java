package io.github.shiv3.ocppsim;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Prototype for issue #111: drive the simulator entirely over the documented
 * Socket.IO control plane and assert a machine-readable verdict (#179), the way
 * a CSMS project's certification IT would — but with the charge-point side
 * supplied turnkey by the container instead of hand-coded per project.
 *
 * <p>This example is self-contained: the CP is never connected to a CSMS
 * (its wsUrl points at a dead port), so an {@code ocpp_absent} assertion for
 * {@code Reset} is deterministically satisfied and the run yields
 * {@code verdict = "PASS"}. Pointing {@code cp.create}'s {@code wsUrl} at a real
 * CSMS-under-test and running a built-in certification scenario (issue #110)
 * is the same shape.
 */
@Testcontainers
class CertificationScenarioIT {

  @Container
  static final OcppCpSimulatorContainer SIMULATOR = new OcppCpSimulatorContainer();

  private static final String CP_ID = "CP-HARNESS";
  private static final int CONNECTOR = 1;

  /** A scenario that completes on its own with no external waits or CSMS. */
  private static final String INLINE_SCENARIO =
      """
      {
        "id": "harness-pass-demo",
        "name": "Harness PASS demo",
        "targetType": "connector",
        "targetId": 1,
        "nodes": [
          { "id": "start-1", "type": "start",      "position": { "x": 0, "y": 0 }, "data": { "label": "S" } },
          { "id": "mv-1",    "type": "meterValue", "position": { "x": 0, "y": 1 }, "data": { "label": "MV", "value": 100, "sendMessage": false } },
          { "id": "end-1",   "type": "end",        "position": { "x": 0, "y": 2 }, "data": { "label": "E" } }
        ],
        "edges": [
          { "id": "e1", "source": "start-1", "target": "mv-1" },
          { "id": "e2", "source": "mv-1", "target": "end-1" }
        ],
        "assertions": [
          { "id": "no-reset", "type": "ocpp_absent", "action": "Reset" }
        ]
      }
      """;

  @Test
  void runsABuiltInStyleScenarioAndReadsThePassVerdict() throws Exception {
    try (SimulatorControlClient client = SimulatorControlClient.connect(SIMULATOR.baseUrl())) {
      List<JSONObject> events = new CopyOnWriteArrayList<>();
      client.onEvent(events::add);

      // 1. Create a charge point. wsUrl points at a dead port on purpose so the
      //    CP stays disconnected and the run needs no live CSMS.
      client.rpc(
          "cp.create",
          new JSONObject()
              .put("cpId", CP_ID)
              .put("wsUrl", "ws://127.0.0.1:65534/never")
              .put("connectors", 1));

      // The registry should now list it.
      JSONArray cps = (JSONArray) client.rpc("cp.list", new JSONObject());
      assertTrue(containsCp(cps, CP_ID), "cp.list should include " + CP_ID);

      // 2. Subscribe to this CP's event room before running anything.
      client.rpc("events.subscribe", new JSONObject().put("scope", CP_ID));

      // 3. Load the inline scenario, then run it.
      Object loaded =
          client.rpc(
              CP_ID,
              "load_scenario",
              new JSONObject()
                  .put("connector", CONNECTOR)
                  .put("scenario", new JSONObject(INLINE_SCENARIO)));
      String scenarioId = scenarioIdOf(loaded);

      client.rpc(
          CP_ID,
          "run_scenario",
          new JSONObject().put("connector", CONNECTOR).put("scenarioId", scenarioId));

      // 4. Poll the machine-readable report (#179) until the run has finished.
      JSONObject report = awaitReport(client, scenarioId);

      // 5. Assert the verdict the way a CSMS certification IT would.
      assertEquals(1, report.getInt("schemaVersion"));
      assertEquals("PASS", report.getString("verdict"), "expected a PASS verdict");

      JSONArray assertions = report.getJSONArray("assertions");
      assertEquals(1, assertions.length());
      JSONObject first = assertions.getJSONObject(0);
      assertEquals("no-reset", first.getString("id"));
      assertEquals("passed", first.getString("status"));

      // The event stream carried the scenario lifecycle too (demonstration).
      assertTrue(
          events.stream().anyMatch(e -> "cp".equals(e.optString("kind"))),
          "expected at least one CP event push");
    }
  }

  private static JSONObject awaitReport(SimulatorControlClient client, String scenarioId)
      throws InterruptedException {
    long deadline = System.currentTimeMillis() + 15_000;
    while (System.currentTimeMillis() < deadline) {
      Object result =
          client.rpc(
              CP_ID,
              "scenario_report",
              new JSONObject().put("connector", CONNECTOR).put("scenarioId", scenarioId));
      if (result instanceof JSONObject report && report.has("verdict")) {
        return report;
      }
      Thread.sleep(200);
    }
    throw new AssertionError("scenario_report never produced a verdict for " + scenarioId);
  }

  private static boolean containsCp(JSONArray cps, String cpId) {
    for (int i = 0; i < cps.length(); i++) {
      if (cpId.equals(cps.getJSONObject(i).optString("cpId"))) {
        return true;
      }
    }
    return false;
  }

  /** load_scenario returns the (possibly retargeted) scenario id. */
  private static String scenarioIdOf(Object loaded) {
    if (loaded instanceof String s && !s.isBlank()) {
      return s;
    }
    if (loaded instanceof JSONObject o) {
      String id = o.optString("id", "");
      if (!id.isBlank()) {
        return id;
      }
    }
    return "harness-pass-demo";
  }
}
