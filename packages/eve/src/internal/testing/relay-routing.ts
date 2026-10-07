import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type { DeliverPayload } from "#channel/types.js";
import type { StepCoordinates as PendingInputBatchEvent } from "#harness/session-machine/view.js";
import type { WorkflowAskRoute, ProxyInputRequest } from "#harness/proxy-input-requests.js";
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
  readonly remote?: ProxyInputRequest["remote"];
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
