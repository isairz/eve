import { openLimit } from "#harness/session-machine/view.js";
import { cleanupHitl } from "./record.js";
import { applyRecordedSettlements } from "./approval.js";
import { authorizationRequested } from "./authorization.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionView, StepCoordinates, TurnState } from "#harness/session-machine/view.js";
import { foldSession } from "#protocol/session-projection.js";
import type { Command, EffectCommand } from "./command.js";
import type { Transition } from "#harness/session-machine/commit.js";
import type { ModelMessage } from "ai";
import { cancel, hold } from "#harness/session-machine/transitions.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { FromStep, FromInbox, FromRelay, FromHost, PolicyCheck, PolicyRun } from "./input.js";
import { typedAnswers } from "./input-typed-reply.js";
import { reduce, verdictsOf } from "./reducer.js";
import { projectHumanInput, projectedSignIns, projectedTurn, sameStep } from "./projection.js";

export type BeforeStepArrival =
  | FromInbox
  | FromRelay
  | FromHost
  | Extract<FromStep, { readonly type: "budget.exceeded" }>;

interface RuleDecision {
  readonly turn: TurnState;
  readonly signIns: readonly AuthorizationChallenge[];
  readonly commands: readonly Command[];
  /** Ephemeral callback facts, installed in the scoped tool context, never persisted. */
  readonly authorizations?: readonly Extract<
    FromHost,
    { readonly type: "authorization.resumed" }
  >[];
}

/** A pure machine transition and the ordered outside actions to run after saving it. */
export interface HumanInputDecision {
  readonly transition: Transition;
  readonly effects: readonly EffectCommand[];
  /** The delivered text answered a request; queued input is a separate delivery. */
  readonly consumedMessage: boolean;
  /** A Stop/cancel belongs to the turn owner, even when this host defers settling it. */
  readonly cancelled: boolean;
  readonly authorizations?: RuleDecision["authorizations"];
}

/** Arrivals are evaluated in originating suspended-step order, then the session's own/relayed requests. */
export function beforeStep(
  view: SessionView,
  arrivals: readonly BeforeStepArrival[],
  checkPolicy?: (check: PolicyCheck) => PolicyRun | undefined,
  options?: { readonly deferCancellation?: true },
): HumanInputDecision {
  let current = view;
  const commands: Command[] = [];
  for (const candidate of Object.values(view.turn.hitl?.audit?.activeCandidates ?? {})) {
    const owner = view.turn.suspended.find((step) =>
      step.requests.some((request) => request.requestId === candidate.requestId),
    );
    if (owner === undefined) continue;
    for (const challenge of candidate.authorizations ?? []) {
      if (view.projection.authorizations[challenge.attemptId ?? challenge.name] === undefined)
        commands.push(authorizationRequested(challenge, owner.event));
    }
  }
  for (const step of view.turn.suspended) {
    const before = projectHumanInput(current, step);
    const reduced = applyRecordedSettlements(before);
    if (reduced.events.length === 0 && reduced.state === before) continue;
    current = {
      ...current,
      projection: reduced.events.reduce(
        (projection, command) =>
          command.type === "publish" ? foldSession(projection, command.event) : projection,
        current.projection,
      ),
      turn: projectedTurn(current, reduced.state, step.event),
      signIns: projectedSignIns(current, before, reduced.state),
    };
    commands.push(...reduced.events);
  }
  const authorizations: Extract<FromHost, { readonly type: "authorization.resumed" }>[] = [];
  for (const step of [...view.turn.suspended, undefined]) {
    for (const arrival of arrivals) {
      if (arrival.type === "authorization.resumed") {
        if (step === undefined) authorizations.push(arrival);
        continue;
      }
      // Session-wide arrivals run once, after the originating held-step lenses.
      if (
        step !== undefined &&
        (arrival.type.startsWith("relayed.") ||
          arrival.type === "delivery.received" ||
          arrival.type === "run.ended" ||
          arrival.type === "budget.exceeded" ||
          arrival.type === "turn.waiting" ||
          arrival.type === "budget.stopped")
      )
        continue;
      if (
        arrival.type === "message.received" &&
        (current.turn.hitl?.readsResults === true || openLimit(current) !== undefined) &&
        typedAnswers(projectHumanInput(current), arrival.text, "own").length === 0
      ) {
        if (step === undefined)
          current = {
            ...current,
            turn: {
              ...current.turn,
              queued: {
                ...current.turn.queued,
                message: arrival.text,
                messageAuth: arrival.sender,
              },
            },
          };
        continue;
      }
      if (
        current.turn.hitl?.readsResults === true &&
        arrival.type === "input.answered" &&
        openLimit(current) === undefined
      ) {
        if (step === undefined)
          current = {
            ...current,
            turn: {
              ...current.turn,
              queued: {
                ...current.turn.queued,
                attributedInputResponses: [
                  ...(current.turn.queued?.attributedInputResponses ?? []),
                  ...arrival.responses.map((response) => ({ auth: arrival.responder, response })),
                ],
              },
            },
          };
        continue;
      }
      const selected =
        step === undefined
          ? undefined
          : current.turn.suspended.find((candidate) => sameStep(candidate.event, step.event));
      if (step !== undefined && selected === undefined) continue;
      const before = projectHumanInput(current, selected);
      const input =
        arrival.type === "input.answered" || arrival.type === "delivery.received"
          ? {
              ...arrival,
              responses: arrival.responses.filter(
                (response) => response.requestId in before.requests,
              ),
            }
          : arrival;
      const parked =
        input.type.startsWith("relayed.") ||
        input.type === "delivery.received" ||
        input.type === "run.ended";
      const reduced = reduce(
        before,
        input,
        parked ? "parked" : "pre-step",
        checkPolicy ?? verdictsOf(input),
      );
      current = {
        ...current,
        projection: reduced.events.reduce(
          (projection, command) =>
            command.type === "publish" ? foldSession(projection, command.event) : projection,
          current.projection,
        ),
        turn: projectedTurn(current, reduced.state, selected?.event),
        signIns: projectedSignIns(current, before, reduced.state),
      };
      commands.push(...reduced.events);
    }
  }
  return finishDecision(
    view,
    {
      turn: current.turn,
      signIns: current.signIns,
      commands,
      ...(authorizations.length > 0 && { authorizations }),
    },
    options?.deferCancellation,
  );
}

/** A whole model response clears the result-reading barrier even when it asks nobody. */
export interface ModelStepResponse {
  readonly at: StepCoordinates;
  readonly inputs: readonly FromStep[];
}

/** Results must identify their originating step: tool call ids can be reused across steps. */
export function afterStep(
  view: SessionView,
  response: (FromStep & { readonly at: StepCoordinates }) | ModelStepResponse,
): HumanInputDecision {
  let current =
    "inputs" in response || response.type !== "actions.settled"
      ? { ...view, turn: { ...view.turn, hitl: cleanupHitl(view.turn.hitl) } }
      : view;
  const commands: Command[] = [];
  const inputs = "inputs" in response ? response.inputs : [response];
  for (const input of inputs) {
    if ("at" in input && !sameStep(input.at, response.at))
      throw new TypeError("A model response cannot contain another step's requests.");
    const selected =
      input.type === "budget.exceeded"
        ? undefined
        : current.turn.suspended.find((step) => sameStep(step.event, response.at));
    const before = projectHumanInput(current, selected);
    const reduced = reduce(
      before,
      input,
      input.type === "budget.exceeded" ? "pre-step" : "post-step",
      verdictsOf(input),
    );
    current = {
      ...current,
      projection: reduced.events.reduce(
        (projection, command) =>
          command.type === "publish" ? foldSession(projection, command.event) : projection,
        current.projection,
      ),
      turn: projectedTurn(
        current,
        reduced.state,
        input.type === "budget.exceeded" ? undefined : response.at,
      ),
      signIns: projectedSignIns(current, before, reduced.state),
    };
    commands.push(...reduced.events);
  }
  return finishDecision(view, { turn: current.turn, signIns: current.signIns, commands });
}

/** Pure dry run across the same originating-step lenses as the committed decision. */
export function policyChecksBeforeStep(
  view: SessionView,
  arrivals: readonly BeforeStepArrival[],
): readonly PolicyCheck[] {
  const checks: PolicyCheck[] = [];
  beforeStep(view, arrivals, (check) => {
    checks.push(check);
    return undefined;
  });
  return checks;
}

/** Assemble the boundary transition before returning it; hosts never translate rule output. */
function finishDecision(
  view: SessionView,
  decision: RuleDecision,
  deferCancellation?: true,
): HumanInputDecision {
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
        if (hasResultFor(command.message, decided))
          turn = { ...turn, hitl: { ...turn.hitl, readsResults: true } };
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
        if (deferCancellation === true && command.type === "cancelTurn") break;
        // A step can already have cancelled the turn before its owner settles it. Its
        // session.waiting checkpoint prunes ended turns, so do not infer an open turn
        // merely from the absence of an explicit cancelled turn in the projection.
        if (
          !cancelled &&
          (projection.activeTurnId !== undefined ||
            view.turn.suspended.length > 0 ||
            openLimit(view) !== undefined ||
            signIns.length > 0 ||
            view.relayedRequestIds.size > 0 ||
            Object.values(projection.inputs).some((input) => input.status !== "settled"))
        ) {
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
        turn = { ...turn, queued: undefined, hitl: cleanupHitl(turn.hitl) };
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
    consumedMessage: decision.commands.some((command) => command.type === "consumeMessage"),
    cancelled: decision.commands.some(
      (command) => command.type === "cancelTurn" || command.type === "declineBudget",
    ),
    ...(decision.authorizations !== undefined && { authorizations: decision.authorizations }),
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
