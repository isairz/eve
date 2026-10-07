import { PROXY_INPUT_REQUESTS_KEY } from "#harness/session-machine/migrate-legacy.js";
import { foldSession } from "#protocol/session-projection.js";
import { writeTurnState } from "#harness/session-machine/state.js";
import { SESSION_PROJECTION_STATE_KEY } from "#harness/session-machine/view.js";
import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { HarnessSessionBase, SessionStateMap } from "#harness/types.js";
import type { InputRequestKind } from "#shared/input.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { migrateSessionState } from "#harness/session-machine/migrate.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type { DeliverPayload } from "#channel/types.js";
import type { StepCoordinates as PendingInputBatchEvent } from "#harness/session-machine/view.js";
import type {
  WorkflowAskRoute,
  ProxyInputQuestion,
  RelayRoute,
} from "#harness/session-machine/human-input-types.js";
import type { InputResolution } from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";
import { inputTextKey, readAnswerText } from "#internal/input-text.js";
import { beforeStep, adaptHumanInput } from "#harness/hitl/index.js";
import type { SessionView } from "#harness/session-machine/view.js";

// ---------------------------------------------------------------------------
// Downward deliver routing
// ---------------------------------------------------------------------------

/** One proxied-child bucket of a routed deliver payload. */
export interface RoutedChildDelivery {
  readonly workflowAsk?: WorkflowAskRoute;
  readonly remote?: RelayRoute["remote"];
  readonly inputSource?: string;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  /** The person's message whose text answered this bucket's question. */
  readonly message?: DeliverPayload["message"];
  readonly payload: { readonly inputResponses: readonly InputResponse[] };
  /** What forwarding this bucket resolves on the routing session. */
  readonly resolved: ProxiedInputResolutions;
}

/**
 * The parent-visible requests one forwarded bucket resolves: those it answers,
 * plus the rest of a batch those answers complete. Each retires from the proxy
 * map, and the session announces them with one `input.resolved` at `event`,
 * the coordinates of the child batch's `input.requested`.
 */
export interface ProxiedInputResolutions {
  readonly event: PendingInputBatchEvent;
  readonly resolutions: readonly InputResolution[];
}

/**
 * Outcome of splitting one deliver payload by the session's proxy map.
 * `forSelf` is the parent-local remainder (or `undefined` when fully
 * routed); `forChildren` carries one entry per descendant token.
 */
export interface RoutedDeliverPayload {
  readonly forChildren: readonly RoutedChildDelivery[];
  readonly forSelf: DeliverPayload | undefined;
  readonly parentAction: { readonly kind: "cancel-turn" } | undefined;
}

/**
 * Test-only compatibility-shaped observer of live beforeStep/adaptHumanInput decisions.
 * Splits a deliver payload into parent-local and proxied-child buckets.
 *
 * With `resolveMessage`, a plain-text message is also resolved against pending
 * `ctx.ask()` questions: when exactly one question is pending, a matching option or
 * permitted free text answers it and consumes the message along with its
 * `context`. Otherwise the message stays with the parent.
 */
export function routeDeliverPayload(input: {
  readonly payload: DeliverPayload;
  readonly view: SessionView;
  readonly resolveMessage?: boolean;
}): RoutedDeliverPayload {
  const { payload, view } = input;
  const text = readAnswerText(payload);
  const decision = beforeStep(view, [
    {
      type: "delivery.received",
      responses: payload.inputResponses ?? [],
      ...(text !== undefined && { message: { text, delegated: input.resolveMessage !== true } }),
    },
  ]);
  const adapted = adaptHumanInput(view, {
    ...decision,
    commands: decision.commands.filter((command) => command.type !== "cancelTurn"),
  });
  const resolutions = adapted.transition.events.flatMap((event) =>
    event.type === "input.resolved" ? [event.data] : [],
  );
  const closedRequestIds = new Set(
    resolutions.flatMap((event) => event.resolutions.map((resolution) => resolution.requestId)),
  );
  const consumed = decision.commands.some((command) => command.type === "consumeMessage");
  const forChildren: RoutedChildDelivery[] = adapted.effects.flatMap((effect) => {
    if (effect.type !== "forwardAnswer") return [];
    const first = effect.responses[0];
    const event = resolutions.find((event) =>
      event.resolutions.some((resolution) => resolution.requestId === first?.requestId),
    );
    if (event === undefined)
      throw new TypeError("A forwarded answer must resolve its parent-visible request.");
    const request =
      first === undefined ? undefined : view.projection.inputs[first.requestId]?.request;
    return [
      {
        childContinuationToken: effect.route.childContinuationToken,
        childSessionInbox: effect.route.childSessionInbox,
        remote: effect.route.remote,
        inputSource: effect.route.inputSource,
        ...(effect.route.control !== undefined &&
          effect.route.runId !== undefined && {
            workflowAsk: {
              control: effect.route.control,
              runId: effect.route.runId,
              question: {
                allowFreeform: request?.allowFreeform,
                options: request?.options,
              },
            },
          }),
        ...(consumed && payload.message !== undefined && { message: payload.message }),
        payload: { inputResponses: effect.responses },
        resolved: {
          event: { sequence: event.sequence, stepIndex: event.stepIndex, turnId: event.turnId },
          resolutions: event.resolutions,
        },
      },
    ];
  });
  const remainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "inputResponses" || value === undefined) continue;
    if (consumed && ["message", "context", inputTextKey].includes(key)) continue;
    remainder[key] = value;
  }
  const responses = (payload.inputResponses ?? []).filter(
    (response) => !closedRequestIds.has(response.requestId),
  );
  if (responses.length > 0) remainder.inputResponses = responses;
  return {
    forChildren,
    forSelf: Object.keys(remainder).length === 0 ? undefined : (remainder as DeliverPayload),
    parentAction: decision.commands.some((command) => command.type === "cancelTurn")
      ? { kind: "cancel-turn" }
      : undefined,
  };
}

/** Routing and control metadata for one descendant-owned input request. */
export interface LegacyRelayFixture {
  readonly remote?: RemoteAgentBinding & { readonly sessionId: string };
  readonly inputSource?: string;
  readonly workflowAsk?: WorkflowAskRoute;
  /**
   * The workflow tool run that relayed the request: its own `ctx.ask()`
   * question, or a request from a session it opened with `ctx.agent`. Nobody
   * can answer the request once that run ends.
   */
  readonly runId?: string;
  /** Batch semantics are optional so sessions written before this field remain routable. */
  readonly batch?: LegacyRelayFixtureBatch;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  /**
   * Coordinates of the `input.requested` this session emitted for the request;
   * the `input.resolved` it emits once it routes the answer repeats them.
   */
  readonly event: PendingInputBatchEvent;
  readonly kind: InputRequestKind;
  /** Question metadata lets the human-facing parent resolve plain text before proxying by ID. */
  readonly question?: ProxyInputQuestion;
}

interface LegacyRelayFixtureBatch {
  readonly approvalRequestIds: readonly string[];
  readonly requestIds: readonly string[];
}

/** `requestId → route` map stored on the parent session. */
type LegacyRelayFixtureMap = Readonly<Record<string, LegacyRelayFixture>>;

/**
 * Returns true when the session is currently proxying one or more
 * HITL requests on behalf of a descendant subagent.
 */
export function hasRelayedRequests(state: SessionStateMap | undefined): boolean {
  for (const _ of getRelayedRequests(state).keys()) {
    return true;
  }
  return false;
}

/**
 * Replaces prior entries for the destination and input source with the provided
 * ones. A child raising a fresh batch overwrites its prior batch so the
 * parent never keeps stale request metadata. Other sources' routes stay
 * independently answerable.
 */
export function seedLegacyRelaySession<S extends HarnessSessionBase>(input: {
  readonly inputSource?: string;
  readonly entries: readonly (readonly [requestId: string, route: LegacyRelayFixture])[];
  readonly forChildContinuationToken: string;
  readonly session: S;
}): S {
  return {
    ...input.session,
    state: seedLegacyRelayState({
      entries: input.entries,
      forChildContinuationToken: input.forChildContinuationToken,
      inputSource: input.inputSource,
      state: input.session.state,
    }),
  };
}

/** Explicit old-key fixture builder for legacy-reader tests; never used by runtime. */
export function seedLegacyRelayState(input: {
  readonly inputSource?: string;
  readonly entries: readonly (readonly [requestId: string, route: LegacyRelayFixture])[];
  readonly forChildContinuationToken: string;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const next: Record<string, LegacyRelayFixture> = {};

  for (const [requestId, route] of Object.entries(readLegacyRoutes(input.state))) {
    if (
      route.childContinuationToken !== input.forChildContinuationToken ||
      route.inputSource !== input.inputSource
    ) {
      next[requestId] = route;
    }
  }

  for (const [requestId, route] of input.entries) {
    next[requestId] = route;
  }

  const state = { ...input.state };
  if (Object.keys(next).length === 0) {
    delete state[PROXY_INPUT_REQUESTS_KEY];
  } else {
    state[PROXY_INPUT_REQUESTS_KEY] = next;
  }
  return Object.keys(state).length > 0 ? state : undefined;
}

/**
 * Projects a {@link SubagentInputRequestHookPayload} into the
 * `(requestId, route)` tuples the session stores.
 */
export function legacyRelayEntries(
  payload: SubagentInputRequestHookPayload,
): readonly (readonly [requestId: string, route: LegacyRelayFixture])[] {
  const batch: LegacyRelayFixtureBatch = {
    approvalRequestIds: payload.event.requests.flatMap((request) =>
      request.kind === "tool-approval" ? [request.requestId] : [],
    ),
    requestIds: payload.event.requests.map((request) => request.requestId),
  };
  const event: PendingInputBatchEvent = {
    sequence: payload.event.sequence,
    stepIndex: payload.event.stepIndex,
    turnId: payload.event.turnId,
  };
  return payload.event.requests.map((request) => {
    const route: {
      readonly childContinuationToken: string;
      readonly inputSource?: string;
      readonly remote?: RemoteAgentBinding & { readonly sessionId: string };
      childSessionInbox?: SessionInboxAddress;
      readonly event: PendingInputBatchEvent;
      readonly kind: InputRequestKind;
      question?: ProxyInputQuestion;
    } & { readonly batch: LegacyRelayFixtureBatch } = {
      batch,
      childContinuationToken: payload.childContinuationToken,
      ...(payload.inputSource !== undefined && { inputSource: payload.inputSource }),
      ...(payload.remote !== undefined && { remote: payload.remote }),
      event,
      kind: request.kind,
    };
    if (request.kind === "question") {
      route.question = {
        ...(request.allowFreeform !== undefined && { allowFreeform: request.allowFreeform }),
        ...(request.options !== undefined && { options: [...request.options] }),
      };
    }
    if (payload.childSessionInbox?.sessionId === payload.childSessionId) {
      route.childSessionInbox = payload.childSessionInbox;
    }

    return [request.requestId, route] as const;
  });
}

function readLegacyRoutes(state: SessionStateMap | undefined): LegacyRelayFixtureMap {
  return (state?.[PROXY_INPUT_REQUESTS_KEY] as LegacyRelayFixtureMap | undefined) ?? {};
}
export function getRelayedRequests(state: SessionStateMap | undefined) {
  const machine = migrateSessionState({ state });
  return new Map(
    Object.entries(
      sessionView(storedProjection(machine.state), machine.state).turn.relayedRoutes ?? {},
    ),
  );
}

/** Seed routing through the same live relay decision used for arriving child batches. */
export function seedRelaySession<S extends HarnessSessionBase>(input: {
  readonly inputSource?: string;
  readonly entries: readonly (readonly [string, LegacyRelayFixture])[];
  readonly forChildContinuationToken: string;
  readonly session: S;
}): S {
  let session = migrateSessionState(input.session);
  const groups = Map.groupBy(input.entries, ([, route]) =>
    JSON.stringify({
      token: route.childContinuationToken,
      inbox: route.childSessionInbox,
      source: route.inputSource,
      event: route.event,
    }),
  );
  for (const entries of groups.values()) {
    const route = entries[0]![1];
    const view = sessionView(storedProjection(session.state), session.state);
    const decision = beforeStep(view, [
      {
        type: "relayed.requested",
        at: route.event,
        requests: entries.map(([requestId, member]) => ({
          requestId,
          kind: member.kind,
          prompt: "",
          action: { kind: "tool-call", callId: requestId, toolName: "", input: {} },
          allowFreeform: (member.workflowAsk?.question ?? member.question)?.allowFreeform,
          options: (member.workflowAsk?.question ?? member.question)?.options?.slice(),
        })),
        route: {
          childContinuationToken: route.childContinuationToken,
          childSessionInbox: route.childSessionInbox,
          remote: route.remote,
          inputSource: route.inputSource,
          runId: route.runId,
          control: route.workflowAsk?.control,
        },
      },
    ]);
    const { transition } = adaptHumanInput(view, decision);
    const projection = transition.events.reduce(foldSession, view.projection);
    session = writeTurnState(
      { ...session, state: { ...session.state, [SESSION_PROJECTION_STATE_KEY]: projection } },
      transition.turn,
    );
  }
  return session;
}
export function seedRelayState(input: {
  readonly inputSource?: string;
  readonly entries: readonly (readonly [string, LegacyRelayFixture])[];
  readonly forChildContinuationToken: string;
  readonly state: SessionStateMap | undefined;
}) {
  return seedRelaySession({
    ...input,
    session: {
      agent: { system: "", tools: [], modelReference: { id: "fixture" } },
      continuationToken: "fixture",
      sessionId: "fixture",
      compaction: { recentWindowSize: 10, threshold: 100000 },
      state: input.state,
    },
  }).state;
}
