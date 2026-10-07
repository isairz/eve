/**
 * Reading human input's state, upgrading what earlier releases stored: grants
 * under the old approved-tools key, a batch parked under the old coordination
 * key, and responders' authorizations that were requests of their own. Kept
 * apart from `state.ts` because upgrading uses the rules, and the state's
 * shapes must not depend on them.
 */
import type { ModelMessage } from "ai";

import type { SessionStateMap, StepInput } from "#harness/types.js";
import { getProxyInputRequests } from "#harness/proxy-input-requests.js";
import { createInputRequestedEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import type { InputRequest } from "#shared/input.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";

import { adoptCandidateAuthorizations } from "./approval-candidate.js";
import { withMessages } from "./held-step.js";
import type { RequestAt } from "./input.js";
import {
  LEGACY_BATCH_KEY,
  LEGACY_GRANTS_KEY,
  parseState,
  STATE_KEY,
  type HeldStep,
  type HumanInputState,
} from "./state.js";

/**
 * The session's human input. A session parked on runtime calls before the
 * held step held them has them under the old coordination key, with its
 * response there: they become the held step, which its approvals' step
 * already was when it had any.
 */
export function readState(sessionState: SessionStateMap | undefined): HumanInputState {
  const state = withLegacyGrants(
    // Responders' authorizations were once requests of their own.
    adoptCandidateAuthorizations(parseState(sessionState?.[STATE_KEY])),
    sessionState?.[LEGACY_GRANTS_KEY],
  );
  const legacy = parseLegacyBatch(sessionState?.[LEGACY_BATCH_KEY]);
  if (legacy === undefined) return state;
  const { held } = state;
  const step: HeldStep = {
    at: held?.at ?? legacy.event,
    messages: withMessages(legacy.responseMessages, held?.messages ?? []),
    runtime: { tasks: [...(held?.runtime?.tasks ?? []), ...legacy.tasks] },
    ...(legacy.followingInput !== undefined && { following: legacy.followingInput }),
  };
  return { ...state, held: step };
}

/** Grants a session stored before `HumanInput` stay granted. */
function withLegacyGrants(state: HumanInputState, value: unknown): HumanInputState {
  if (!Array.isArray(value)) return state;
  const legacy = value.filter((key): key is string => typeof key === "string");
  const grants = [...new Set([...state.grants, ...legacy])];
  return grants.length === state.grants.length ? state : { ...state, grants };
}

interface LegacyBatch {
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly event: RequestAt;
  readonly responseMessages: readonly ModelMessage[];
  readonly followingInput?: StepInput;
}

function parseLegacyBatch(value: unknown): LegacyBatch | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const batch = value as LegacyBatch;
  if (
    !Array.isArray(batch.tasks) ||
    !Array.isArray(batch.responseMessages) ||
    typeof batch.event !== "object" ||
    batch.event === null
  ) {
    return undefined;
  }
  return batch;
}

/**
 * Pure legacy rule-test compatibility transform; runtime entry points never call it.
 * Returns the old keyed representation, removing its key when nothing is open.
 */
export function store(
  sessionState: SessionStateMap | undefined,
  state: HumanInputState,
): SessionStateMap | undefined {
  const next: Record<string, unknown> = { ...sessionState };
  // `readState` moved a legacy batch and grants into `state`.
  delete next[LEGACY_BATCH_KEY];
  delete next[LEGACY_GRANTS_KEY];
  if (isEmpty(state)) delete next[STATE_KEY];
  else next[STATE_KEY] = state;
  return Object.keys(next).length > 0 ? next : undefined;
}

function isEmpty(state: HumanInputState): boolean {
  return (
    Object.keys(state.requests).length === 0 &&
    state.queued === undefined &&
    state.held === undefined &&
    state.grants.length === 0 &&
    state.audit === undefined &&
    Object.keys(state.relayedAuthorizations ?? {}).length === 0
  );
}

/** Upgrade keys are inspected only at hydration; the replacement is saved as one state map. */
export const LEGACY_PARKING_KEYS = [
  STATE_KEY,
  LEGACY_BATCH_KEY,
  LEGACY_GRANTS_KEY,
  "eve.runtime.proxyInputRequests",
  "eve.runtime.hitl.approvalState",
] as const;

export function hasLegacyParkingState(state: SessionStateMap | undefined): boolean {
  return LEGACY_PARKING_KEYS.some((key) => state !== undefined && Object.hasOwn(state, key));
}

/** Removing keys and installing their replacement must be part of the same checkpoint write. */
export function clearLegacyParkingState(
  state: SessionStateMap | undefined,
): SessionStateMap | undefined {
  const next = { ...state };
  for (const key of LEGACY_PARKING_KEYS) delete next[key];
  return Object.keys(next).length === 0 ? undefined : next;
}

/** Restore routing facts absent from older checkpoints, without republishing their requests. */
export function legacyRequestedEvents(
  state: SessionStateMap | undefined,
  projection: SessionProjection,
): readonly UnstampedMessageStreamEvent[] {
  const events: UnstampedMessageStreamEvent[] = [];
  for (const open of Object.values(readState(state).requests)) {
    if (open.kind === "authorization" || projection.inputs[open.request.requestId] !== undefined)
      continue;
    events.push(createInputRequestedEvent({ ...open.at, requests: [open.request] }));
  }
  for (const [requestId, route] of getProxyInputRequests(state)) {
    if (
      projection.inputs[requestId] !== undefined ||
      events.some(
        (event) =>
          event.type === "input.requested" &&
          event.data.requests.some((request) => request.requestId === requestId),
      )
    )
      continue;
    // The old routing record kept question metadata, not the original action. This synthetic
    // request is routing-only: it is never republished or treated as an owned approval.
    const request: InputRequest = {
      action: { kind: "tool-call", callId: requestId, toolName: "", input: {} },
      kind: route.kind,
      prompt: "",
      requestId,
      allowFreeform: (route.workflowAsk?.question ?? route.question)?.allowFreeform,
      options:
        (route.workflowAsk?.question ?? route.question)?.options === undefined
          ? undefined
          : [...((route.workflowAsk?.question ?? route.question)?.options ?? [])],
    };
    events.push(createInputRequestedEvent({ ...route.event, requests: [request] }));
  }
  return events;
}
