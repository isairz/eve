import { applyTransition, sessionView, type Transition } from "#harness/session-machine/commit.js";
import { receiveRelayedAnswer } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { adaptHumanInput, type EffectCommand } from "#harness/hitl/index.js";
import { beforeStep } from "#harness/hitl/index.js";
import { dispatchHumanInputEffects, effectHandlers } from "#harness/hitl/index.js";
import { foldSession } from "#protocol/session-projection.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import { buildAdapterContext } from "#channel/adapter-context.js";
import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { AuthKey, TurnDeliveryIdsKey } from "#context/keys.js";
import { setChannelContext } from "#execution/channel-context.js";
import {
  type DurableSessionState,
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import {
  publishFromSessionStep,
  publishSessionEvents,
  restoreSessionStep,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";
import { inputTextKey, readAnswerText } from "#internal/input-text.js";

export type RoutedDeliverResult =
  | {
      readonly kind: "cancel-turn";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly kind: "continue";
      readonly remainder: DeliverHookPayload | undefined;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    };

/** A durable delivery boundary; decisions are committed before their ordered transport effects. */
export async function routeProxiedDeliverStep(
  input: SessionStepState & { readonly delivery: DeliverHookPayload },
): Promise<WithSessionStateDelta<RoutedDeliverResult>> {
  "use step";
  return await withSessionStateDelta(input, routeProxiedDeliver);
}

async function routeProxiedDeliver(
  input: SessionStepState & { readonly delivery: DeliverHookPayload },
): Promise<RoutedDeliverResult> {
  const session = readDurableSession(input.sessionState);
  const initial = sessionView(storedProjection(session.state), session.state);
  const { delivery, serializedContext } = await deliverChannelInputResponses({
    ...input,
    routable: (response) => initial.relayedRequestIds.has(response.requestId),
  });
  const delegated = hasDelegatedSessionContext(serializedContext) || delivery.caller !== undefined;
  let view = initial;
  const events: UnstampedMessageStreamEvent[] = [];
  const own: UnstampedMessageStreamEvent[] = [];
  const effects: EffectCommand[] = [];
  const kept: [number, DeliverPayload][] = [];
  const answerDeliveryIds: string[] = [];
  let cancelled = false;
  for (const [index, payload] of delivery.payloads.entries()) {
    const text = readAnswerText(payload);
    const decision = beforeStep(view, [
      {
        type: "delivery.received",
        responses: payload.inputResponses ?? [],
        ...(text !== undefined && { message: { text, delegated } }),
      },
    ]);
    cancelled ||= decision.commands.some((command) => command.type === "cancelTurn");
    // This step does not own history. The owner settles a Stop through its history-bearing
    // cancellation step, which commits the stopped model response exactly once.
    const adapted = adaptHumanInput(view, {
      ...decision,
      commands: decision.commands.filter((command) => command.type !== "cancelTurn"),
    });
    const consumed = decision.commands.some((command) => command.type === "consumeMessage");
    const forwarded = new Set(
      adapted.effects.flatMap((effect) =>
        effect.type === "forwardAnswer"
          ? effect.responses.map((response) => response.requestId)
          : [],
      ),
    );
    const remainder: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key === "inputResponses" || value === undefined) continue;
      if (consumed && ["message", "context", inputTextKey].includes(key)) continue;
      remainder[key] = value;
    }
    const responses = (payload.inputResponses ?? []).filter(
      (response) => !forwarded.has(response.requestId),
    );
    if (responses.length > 0) remainder.inputResponses = responses;
    if (Object.keys(remainder).length > 0) kept.push([index, remainder as DeliverPayload]);
    if (consumed && payload.message !== undefined) {
      const first = adapted.effects.find((effect) => effect.type === "forwardAnswer");
      const requestId = first?.type === "forwardAnswer" ? first.responses[0]?.requestId : undefined;
      const at = requestId === undefined ? undefined : view.projection.inputs[requestId];
      if (at !== undefined)
        own.push(
          receiveRelayedAnswer({
            message: payload.message,
            sequence: at.sequence,
            turnId: at.turnId,
          }),
        );
      answerDeliveryIds.push(
        ...(delivery.deliveryMetadata ?? [])
          .filter((item) => item.payloadIndex === index)
          .map((item) => item.deliveryId),
      );
    }
    events.push(...adapted.transition.events);
    effects.push(...adapted.effects);
    view = {
      ...view,
      projection: adapted.transition.events.reduce(foldSession, view.projection),
      turn: adapted.transition.turn,
      signIns: adapted.transition.signIns ?? view.signIns,
      relayedRequestIds: new Set(Object.keys(adapted.transition.turn.hitl?.relayedRoutes ?? {})),
    };
  }
  if (events.length > 0 && kept.length === 0 && !cancelled && view.relayedRequestIds.size > 0) {
    const waiting = adaptHumanInput(view, beforeStep(view, [{ type: "turn.waiting" }]));
    events.push(...waiting.transition.events);
    view = { ...view, turn: waiting.transition.turn };
  }
  const transition: Transition = { turn: view.turn, signIns: view.signIns, events };
  const target = {
    ...input,
    serializedContext: joinTurnDeliveryIds(serializedContext, answerDeliveryIds),
  };
  if (events.length === 0 && effects.length === 0 && own.length === 0)
    return {
      kind: "continue",
      serializedContext,
      sessionState: replaceDurableSessionSnapshot({ session, state: input.sessionState }),
      remainder: delivery,
    };
  const ownPublished = await publishSessionEvents(target, own);
  const restored = await restoreSessionStep({ ...target, ...ownPublished });
  const { published } = await publishFromSessionStep(restored, {
    origin: "relayed",
    async publish(emit, current) {
      const applied = await applyTransition(current, transition, emit);
      await dispatchHumanInputEffects(
        effects,
        effectHandlers({
          context: restored.ctx,
          delivery,
          forwardedRequestIds: new Set(
            effects.flatMap((effect) =>
              effect.type === "forwardAnswer"
                ? effect.responses.map((response) => response.requestId)
                : [],
            ),
          ),
        }),
      );
      return applied;
    },
    updateSession(_session, applied) {
      return { session: applied };
    },
  });
  if (cancelled) return { ...published, kind: "cancel-turn" };
  const metadata = kept.flatMap(([index], payloadIndex) =>
    (delivery.deliveryMetadata ?? [])
      .filter((item) => item.payloadIndex === index)
      .map((item) => ({ ...item, payloadIndex })),
  );
  return {
    ...published,
    kind: "continue",
    remainder:
      kept.length === 0
        ? undefined
        : {
            ...delivery,
            payloads: kept.map(([, payload]) => payload),
            deliveryMetadata: metadata.length === 0 ? undefined : metadata,
          },
  };
}

function joinTurnDeliveryIds(
  serializedContext: Record<string, unknown>,
  deliveryIds: readonly string[],
): Record<string, unknown> {
  if (deliveryIds.length === 0) return serializedContext;
  const current =
    (serializedContext[TurnDeliveryIdsKey.name] as readonly string[] | undefined) ?? [];
  return {
    ...serializedContext,
    [TurnDeliveryIdsKey.name]: [...new Set([...current, ...deliveryIds])],
  };
}

/**
 * Maps a delivery's channel-specific answers to the requests a held turn waits
 * on, so the turn can tell they answer it. Returns the mapped delivery, or
 * `undefined` when the channel maps none of them to one of `requestIds`.
 */
export async function mapHeldInputResponsesStep(
  input: SessionStepState & {
    readonly delivery: DeliverHookPayload;
    readonly requestIds: readonly string[];
  },
): Promise<WithSessionStateDelta<{ readonly delivery: DeliverHookPayload | undefined }>> {
  "use step";
  return await withSessionStateDelta(input, async () => {
    const requestIds = new Set(input.requestIds);
    const mapped = await deliverChannelInputResponses({
      ...input,
      routable: (response) => requestIds.has(response.requestId),
    });
    return mapped.delivery === input.delivery
      ? { delivery: undefined }
      : { delivery: mapped.delivery, serializedContext: mapped.serializedContext };
  });
}

/**
 * Maps each input response this session cannot route as sent through the
 * channel's `deliver` hook, and routes what it maps to a `routable` request.
 * Telegram buttons, for example, carry compact callback ids that only its hook
 * resolves against channel state. Every other response stays as sent for the
 * turn's own `deliver` call.
 */
async function deliverChannelInputResponses(
  input: SessionStepState & {
    readonly delivery: DeliverHookPayload;
    readonly routable: (response: InputResponse) => boolean;
  },
): Promise<{
  readonly delivery: DeliverHookPayload;
  readonly serializedContext: Record<string, unknown>;
}> {
  const { routable } = input;
  const unrouted = input.delivery.payloads.some(
    (payload) => payload.inputResponses?.some((response) => !routable(response)) === true,
  );
  if (!unrouted) return input;
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  if (adapter.deliver === undefined) return input;

  // The hook sees this delivery's caller, as it does in the turn.
  if (input.delivery.auth !== undefined) ctx.set(AuthKey, input.delivery.auth ?? null);
  // Each hook call edits its own copy of channel state, kept only when it maps
  // to a routable request; a response put back as sent must stay resolvable.
  let state = adapter.state ?? {};
  let mapped = false;
  const payloads: DeliverPayload[] = [];
  for (const payload of input.delivery.payloads) {
    if (payload.inputResponses === undefined) {
      payloads.push(payload);
      continue;
    }
    const responses: InputResponse[] = [];
    for (const response of payload.inputResponses) {
      if (routable(response)) {
        responses.push(response);
        continue;
      }
      const adapterCtx = buildAdapterContext({ ...adapter, state: structuredClone(state) }, ctx);
      const result = await adapter.deliver(
        { ...payload, inputResponses: [response], message: undefined },
        adapterCtx,
      );
      const routed = result?.inputResponses?.filter(routable) ?? [];
      if (routed.length === 0) {
        responses.push(response);
        continue;
      }
      mapped = true;
      state = adapterCtx.state;
      responses.push(...routed);
    }
    payloads.push({ ...payload, inputResponses: responses });
  }
  if (!mapped) return input;

  // Only the channel state the mapping consumed carries over; the turn applies
  // the rest of this delivery, such as its caller, itself.
  const session = await deserializeContext(input.serializedContext);
  setChannelContext(session, { ...adapter, state });
  return {
    delivery: { ...input.delivery, payloads },
    serializedContext: serializeContext(session),
  };
}
