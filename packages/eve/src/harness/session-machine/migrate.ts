import type { AuthorizationChallenge } from "#harness/authorization.js";
import { projectedSignIns, projectedTurn, sameStep } from "#harness/hitl/projection.js";
import { readTurnState, type TurnState } from "#harness/session-machine/state.js";
import { SESSION_PROJECTION_STATE_KEY, storedProjection } from "#harness/session-machine/view.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import type { SessionStateMap } from "#harness/types.js";
import { foldSession } from "#protocol/session-projection.js";
import {
  clearLegacyParkingState,
  getProxyInputRequests,
  hasLegacyParkingState,
  LEGACY_BATCH_KEY,
  LEGACY_GRANTS_KEY,
  legacyApprovalAudit,
  legacyRequestedEvents,
  mergeApprovalAudits,
  parseLegacyBatch,
  readState,
  STATE_KEY,
} from "./migrate-legacy.js";
import type { SessionView } from "./view.js";
import { writeTurnState } from "./state.js";

/** Pure hydration: old keys and their replacement belong to one atomic checkpoint write. */
function upgradeLegacyState(
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
  const upgraded = projectLegacyState(
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

/** Pure upgrade projection. Hydration will apply it and clear the old keys in the migration phase. */
function projectLegacyState(
  view: SessionView,
  state: SessionStateMap | undefined,
): { readonly turn: TurnState; readonly signIns: readonly AuthorizationChallenge[] } {
  const read = readState(state);
  const approval = Object.values(read.requests).find((request) => request.kind === "tool-approval");
  // Old releases committed the asking transcript before parking its approval; preserve the
  // empty originating step so cancellation still commits the missing denied-call results.
  const legacy =
    read.held === undefined && approval !== undefined
      ? { ...read, held: { at: approval.at, messages: [] } }
      : read;
  const hasHumanState = [STATE_KEY, LEGACY_BATCH_KEY, LEGACY_GRANTS_KEY].some(
    (key) => state !== undefined && Object.hasOwn(state, key),
  );
  const global = hasHumanState ? projectedTurn(view, legacy) : view.turn;
  const turn =
    !hasHumanState || legacy.held === undefined
      ? global
      : projectedTurn({ ...view, turn: global }, legacy, legacy.held.at);
  const proxyRoutes = Object.fromEntries(
    [...getProxyInputRequests(state)].map(([id, route]) => [
      id,
      {
        childContinuationToken: route.childContinuationToken,
        childSessionInbox: route.childSessionInbox,
        remote: route.remote,
        inputSource: route.inputSource,
        runId: route.runId,
        control: route.workflowAsk?.control,
      },
    ]),
  );
  return {
    turn: {
      ...turn,
      suspended:
        read.held === undefined && approval !== undefined
          ? turn.suspended.map((step) =>
              sameStep(step.event, approval.at)
                ? { ...step, transcriptCommitted: true as const }
                : step,
            )
          : turn.suspended,
      grants: [...new Set([...turn.grants, ...view.turn.grants])],
      queued: view.turn.queued ?? turn.queued,
      audit: view.turn.audit ?? turn.audit,
      relayedRoutes: {
        ...proxyRoutes,
        ...Object.fromEntries(
          Object.entries(legacy.requests).flatMap(([id, request]) =>
            request.kind === "relayed" ? [[id, request.route]] : [],
          ),
        ),
        ...view.turn.relayedRoutes,
      },
      relayedAuthorizations: {
        ...legacy.relayedAuthorizations,
        ...view.turn.relayedAuthorizations,
      },
    },
    signIns: hasHumanState
      ? projectedSignIns(view, { grants: [], requests: {} }, legacy)
      : view.signIns,
  };
}

/** Pure, idempotent checkpoint upgrade; step-side reads are the runtime entry point. */
export function migrateSessionState<T extends { readonly state?: SessionStateMap }>(session: T): T {
  if (
    session.state?.[LEGACY_BATCH_KEY] !== undefined &&
    parseLegacyBatch(session.state[LEGACY_BATCH_KEY]) === undefined
  ) {
    throw new Error("Malformed legacy coordination batch; cannot resume session");
  }
  const migrated = upgradeLegacyState(session.state);
  return migrated === undefined
    ? session
    : writeTurnState({ ...session, state: migrated.state }, migrated.turn);
}
