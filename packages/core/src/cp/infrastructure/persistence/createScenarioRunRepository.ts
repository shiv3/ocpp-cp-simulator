import type { Database } from "../../domain/persistence/Database";
import {
  InMemoryScenarioRunRepository,
  type ScenarioRunRepository,
} from "../../application/verification/ScenarioRunRepository";
import { SqliteScenarioRunRepository } from "./SqliteScenarioRunRepository";

/** The run history for a daemon (#388): the `scenario_runs` table on
 *  `database`, or a bounded in-memory store without one. */
export function createScenarioRunRepository(
  database: Database | null,
): ScenarioRunRepository {
  return database
    ? new SqliteScenarioRunRepository(database)
    : new InMemoryScenarioRunRepository();
}
