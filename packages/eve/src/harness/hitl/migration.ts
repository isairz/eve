import { legacyApprovalAudit, mergeApprovalAudits } from "./candidates.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionStateMap } from "#harness/types.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import { legacyProjection } from "#harness/hitl/projection.js";
import {
  hasLegacyParkingState,
  clearLegacyParkingState,
  legacyRequestedEvents,
} from "#harness/hitl/state-legacy.js";
import { foldSession } from "#protocol/session-projection.js";
import { readTurnState, type TurnState } from "#harness/session-machine/state.js";
import { storedProjection, SESSION_PROJECTION_STATE_KEY } from "#harness/session-machine/view.js";

/** Pure hydration: old keys and their replacement belong to one atomic checkpoint write. */
export function migrateLegacyParkingState(
  state: SessionStateMap | undefined,
): { readonly state: SessionStateMap; readonly turn: TurnState } | undefined {
  if (!hasLegacyParkingState(state)) return undefined;
  const session = { state };
  const previous = storedProjection(session.state);
  const projection = legacyRequestedEvents(session.state, previous).reduce(foldSession, previous);
  const turn = readTurnState(session.state);
  const pending = session.state?.["eve.runtime.pendingAuthorization"] as
    | { readonly challenges: readonly AuthorizationChallenge[] }
    | undefined;
  const upgraded = legacyProjection(
    {
      projection,
      turn,
      signIns: pending?.challenges ?? [],
      relayedRequestIds: new Set(Object.keys(turn.relayedRoutes ?? {})),
      usage: getSessionUsage(session),
    },
    session.state,
  );
  const migrated: Record<string, unknown> = {
    ...clearLegacyParkingState(session.state),
    [SESSION_PROJECTION_STATE_KEY]: projection,
  };
  if (upgraded.signIns.length === 0) delete migrated["eve.runtime.pendingAuthorization"];
  else migrated["eve.runtime.pendingAuthorization"] = { challenges: upgraded.signIns };
  return {
    state: migrated,
    turn: {
      ...upgraded.turn,
      audit: mergeApprovalAudits(legacyApprovalAudit(state), upgraded.turn.audit),
    },
  };
}
