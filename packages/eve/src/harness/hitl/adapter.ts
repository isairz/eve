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
        turn = { ...turn, readsResults: true };
        break;
      case "resumeInput":
        turn = { ...turn, queued: command.input };
        break;
      case "consumeMessage": {
        const { message: _message, messageAuth: _auth, ...input } = turn.queued ?? {};
        turn = { ...turn, queued: Object.keys(input).length > 0 ? input : undefined };
        break;
      }
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
