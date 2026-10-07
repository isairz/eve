import type { SessionStateMap } from "#harness/types.js";
import { migrateLegacyParkingState } from "#harness/hitl/migration.js";
import { writeTurnState } from "./state.js";

/** Install the upgraded machine state and clear its legacy keys in one checkpoint write. */
export function hydrateMachineState<T extends { readonly state?: SessionStateMap }>(session: T): T {
  const migrated = migrateLegacyParkingState(session.state);
  return migrated === undefined
    ? session
    : writeTurnState({ ...session, state: migrated.state }, migrated.turn);
}
