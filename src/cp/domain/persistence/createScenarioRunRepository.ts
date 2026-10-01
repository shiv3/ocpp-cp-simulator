import type { Database } from "./Database";
import {
  InMemoryScenarioRunRepository,
  type ScenarioRunRepository,
} from "./ScenarioRunRepository";
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
