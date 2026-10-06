import type { ModelMessage } from "ai";
import type { Transition } from "#harness/session-machine/commit.js";
import { cancel, hold } from "#harness/session-machine/transitions.js";
import type { SessionView } from "#harness/session-machine/view.js";
import { foldSession } from "#protocol/session-projection.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { Command } from "./command.js";
import type { HumanInputDecision } from "./decisions.js";

export type EffectCommand = Extract<
  Command,
  { readonly type: "forwardAnswer" | "withdrawQuestion" | "resumeAuthorization" }
>;

/**
 * Apply/commit the transition first, then dispatch this ordered outbox. Dispatchers must dedupe
 * forwarding/withdrawal by requestId and authorization resumes by attemptId (or request id).
 * A completion returns as a new beforeStep arrival, never a direct state write. Durable outbox
 * replay and receiver deduplication are supplied by the session/workflow effect hosts, not here.
 */
export interface AdaptedHumanInput {
  readonly transition: Transition;
  readonly effects: readonly EffectCommand[];
}

/** Unused until the runtime switches: pure command-to-machine adaptation. */
export function adaptHumanInput(
  view: SessionView,
  decision: HumanInputDecision,
): AdaptedHumanInput {
  let turn = decision.turn;
  let projection = view.projection;
  let signIns = decision.signIns;
  let grantBudget: true | undefined;
  let cancelled = false;
  const events: UnstampedMessageStreamEvent[] = [];
  const commit: ModelMessage[] = [];
  const effects: EffectCommand[] = [];
  const decided = decidedCallIds(view);
  const appendEvents = (next: readonly UnstampedMessageStreamEvent[]) => {
    for (const event of next) {
      events.push(event);
      projection = foldSession(projection, event);
    }
  };
  const compose = (next: Transition) => {
    turn = next.turn;
    if (next.signIns !== undefined) signIns = next.signIns;
    commit.push(...(next.commit ?? []));
    appendEvents(next.events);
  };
  for (const command of decision.commands) {
    switch (command.type) {
      // Relayed events already contain their source coordinates, exactly as machine.relay keeps them.
      case "publish":
        appendEvents([command.event]);
        break;
      case "appendHistory":
        commit.push(command.message);
        // Only a person's decision holds later arrivals: runtime results join as on main.
        if (hasResultFor(command.message, decided)) turn = { ...turn, readsResults: true };
        break;
      case "resumeInput":
        turn = { ...turn, queued: command.input };
        break;
      case "consumeMessage":
        // The delivered message is consumed by intake; queued input is a different delivery.
        break;
      case "addNote":
        turn = {
          ...turn,
          queued: { ...turn.queued, context: [...(turn.queued?.context ?? []), command.text] },
        };
        break;
      case "grantBudget":
        grantBudget = true;
        break;
      case "waitTurn":
        compose(hold({ ...view, projection, turn, signIns }, { on: "input" }));
        break;
      case "cancelTurn":
      case "declineBudget":
        if (!cancelled) {
          // Every lens already decided its closures. Do not let the machine cancel invent
          // duplicate withdrawals for another lens whose resolution is later in this batch.
          const closedProjection = decision.commands.reduce(
            (current, pending) =>
              pending.type === "publish" &&
              (pending.event.type === "input.resolved" ||
                pending.event.type === "authorization.completed")
                ? foldSession(current, pending.event)
                : current,
            projection,
          );
          compose(cancel({ ...view, projection: closedProjection, turn, signIns }));
          cancelled = true;
        }
        turn = { ...turn, queued: undefined, readsResults: undefined };
        break;
      case "forwardAnswer":
      case "withdrawQuestion":
      case "resumeAuthorization":
        effects.push(command);
        break;
      default:
        command satisfies never;
    }
  }
  return {
    transition: {
      turn,
      events,
      ...(commit.length > 0 && { commit }),
      signIns,
      ...(grantBudget === true && { grantBudget }),
    },
    effects,
  };
}

/** Calls a person approved or was asked about, whose results the model reads before more input. */
function decidedCallIds(view: SessionView): ReadonlySet<string> {
  return new Set(
    view.turn.suspended.flatMap((step) =>
      [...step.requests, ...(step.approved ?? [])].flatMap((request) =>
        request.action.kind === "tool-call" ? [request.action.callId] : [],
      ),
    ),
  );
}

function hasResultFor(message: ModelMessage, callIds: ReadonlySet<string>): boolean {
  return (
    message.role === "tool" &&
    message.content.some((part) => part.type === "tool-result" && callIds.has(part.toolCallId))
  );
}
