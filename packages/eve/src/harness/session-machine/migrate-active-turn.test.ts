import { describe, expect, it } from "vitest";
import type { SessionInboxPayload, SessionInboxReader } from "#execution/session-inbox/inbox.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { readDurableSession as readCheckpoint } from "#execution/durable-session-read.js";
import {
  DURABLE_SESSION_VERSION,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { createSessionLimitContinuationRequest } from "#harness/hitl/budget-question.js";
import { LEGACY_PARKING_KEYS } from "#harness/session-machine/migrate-legacy.js";
import { sessionView } from "#harness/session-machine/commit.js";
import {
  SESSION_PROJECTION_STATE_KEY,
  storedProjection,
  turnPosition,
} from "#harness/session-machine/view.js";
import type { SessionStateMap } from "#harness/types.js";
import { createSessionStartedEvent, createTurnStartedEvent } from "#protocol/message.js";
import { foldSession, initialSessionProjection } from "#protocol/session-projection.js";
import type { InputRequest } from "#shared/input.js";
import { ActiveTurn } from "#execution/session/active-turn.js";
import type { SessionExecutionInput } from "#execution/session/turn.js";

const at = { sequence: 7, stepIndex: 1, turnId: "turn_7" };
const approval: InputRequest = {
  action: { kind: "tool-call", callId: "deploy-call", toolName: "deploy", input: {} },
  kind: "tool-approval",
  prompt: "Approve deploy?",
  requestId: "deploy",
};
const budget = createSessionLimitContinuationRequest({
  sessionId: "s1",
  turnSequence: 7,
  violation: { kind: "input", limit: 10, usedTokens: 11 },
});

/** A checkpoint an earlier release saved, read before any step hydrates it. */
function legacyCheckpoint(input: {
  readonly activeTurn: boolean;
  readonly humanInput: unknown;
}): DurableSessionState {
  const events = [
    createSessionStartedEvent(),
    ...(input.activeTurn ? [createTurnStartedEvent({ sequence: 7, turnId: "turn_7" })] : []),
  ];
  const state: SessionStateMap = {
    [SESSION_PROJECTION_STATE_KEY]: events.reduce(foldSession, initialSessionProjection()),
    "eve.harness.humanInput": input.humanInput,
    "eve.runtime.proxyInputRequests": {
      relayed: { childContinuationToken: "child", event: at, kind: "question" },
    },
  } as SessionStateMap;
  return {
    version: DURABLE_SESSION_VERSION,
    sessionId: "s1",
    continuationToken: "token",
    hasProxyInputRequests: false,
    snapshot: { session: { sessionId: "s1", continuationToken: "token", state } },
  } as DurableSessionState;
}

const parkedApproval = legacyCheckpoint({
  activeTurn: true,
  humanInput: {
    grants: [],
    requests: {
      deploy: {
        kind: "tool-approval",
        at,
        request: approval,
        requester: null,
        approvalKey: "deploy",
      },
    },
    held: { at, messages: [] },
  },
});
const parkedBudget = legacyCheckpoint({
  activeTurn: false,
  humanInput: {
    grants: [],
    requests: { [budget.requestId]: { kind: "session-limit", at, request: budget } },
  },
});

function activeTurn(sessionState: DurableSessionState) {
  const interrupts = new Set<(payload: SessionInboxPayload) => void>();
  const deliveries = new Set<(payload: SessionInboxPayload) => void>();
  const input = {
    cursor: { sessionState } as SessionStateCursor,
    inbox: {
      onInterrupt: (handler: (payload: SessionInboxPayload) => void) => {
        interrupts.add(handler);
        return () => {
          interrupts.delete(handler);
        };
      },
      onDelivery: (handler: (payload: SessionInboxPayload) => void) => {
        deliveries.add(handler);
        return () => {
          deliveries.delete(handler);
        };
      },
    } as SessionInboxReader,
    sessionId: "s1",
  } as SessionExecutionInput;
  const turn = new ActiveTurn(input, { caller: undefined, principal: "anonymous" });
  return {
    turn,
    interrupt: (payload: SessionInboxPayload) => interrupts.forEach((handler) => handler(payload)),
    deliver: (payload: SessionInboxPayload) => deliveries.forEach((handler) => handler(payload)),
  };
}

describe("workflow-side reads of a legacy checkpoint", () => {
  it("leave the turn position the migration would produce", () => {
    for (const checkpoint of [parkedApproval, parkedBudget]) {
      const raw = readCheckpoint(checkpoint).state;
      expect(LEGACY_PARKING_KEYS.some((key) => raw?.[key] !== undefined)).toBe(true);
      expect(turnPosition(storedProjection(raw))).toEqual(
        turnPosition(storedProjection(readDurableSession(checkpoint).state)),
      );
    }
  });

  it("cancel the active turn by its id before any step hydrates it", () => {
    const other = activeTurn(parkedApproval);
    other.interrupt({ kind: "cancel", turnId: "turn_6" } as SessionInboxPayload);
    expect(other.turn.signal.aborted).toBe(false);
    other.turn.dispose();

    const current = activeTurn(parkedApproval);
    current.interrupt({ kind: "cancel", turnId: "turn_7" } as SessionInboxPayload);
    expect(current.turn.signal.aborted).toBe(true);
    current.turn.dispose();
  });

  it("steer the active turn before any step hydrates it", () => {
    const { turn, deliver } = activeTurn(parkedApproval);
    deliver({ kind: "deliver", payloads: [{ message: "use staging" }] } as SessionInboxPayload);
    expect(turn.steeringSignal.aborted).toBe(true);
    expect(turn.signal.aborted).toBe(false);
    turn.dispose();
  });
});

describe("step-side reads of a legacy checkpoint", () => {
  it("hydrate a parked approval so it resumes", () => {
    const session = readDurableSession(parkedApproval);
    for (const key of LEGACY_PARKING_KEYS) expect(session.state?.[key]).toBeUndefined();
    const view = sessionView(storedProjection(session.state), session.state);
    expect(view.turn.suspended[0]?.requests).toEqual([approval]);
    expect(view.turn.relayedRoutes?.relayed).toBeDefined();
  });

  it("hydrate a parked budget question so it resumes", () => {
    const session = readDurableSession(parkedBudget);
    for (const key of LEGACY_PARKING_KEYS) expect(session.state?.[key]).toBeUndefined();
    const view = sessionView(storedProjection(session.state), session.state);
    expect(view.turn.limitRequest?.request).toEqual(budget);
  });
});
