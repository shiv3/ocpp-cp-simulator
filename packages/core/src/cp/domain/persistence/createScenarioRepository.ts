import type { Database } from "./Database";
import {
  InMemoryScenarioRepository,
  type ScenarioRepository,
} from "./ScenarioRepository";
import { SqliteScenarioRepository } from "./SqliteScenarioRepository";

/** A daemon's scenario definitions (#495): the `scenarios` table on
 *  `database`, or an in-memory store without one. */
export function createScenarioRepository(
  database: Database | null,
): ScenarioRepository {
  return database
    ? new SqliteScenarioRepository(database)
    : new InMemoryScenarioRepository();
}
