import { cleanupHitl } from "./record.js";
import { applyRecordedSettlements } from "./approval.js";
import { authorizationRequested } from "./authorization.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionView, StepCoordinates, TurnState } from "#harness/session-machine/view.js";
import { foldSession } from "#protocol/session-projection.js";
import type { Command } from "./command.js";
import type { FromStep, FromInbox, FromRelay, FromHost, PolicyCheck, PolicyRun } from "./input.js";
import { typedAnswers } from "./input-typed-reply.js";
import { reduce, verdictsOf } from "./reducer.js";
import { projectHumanInput, projectedSignIns, projectedTurn, sameStep } from "./projection.js";

export type BeforeStepArrival =
  | FromInbox
  | FromRelay
  | FromHost
  | Extract<FromStep, { readonly type: "budget.exceeded" }>;

export interface HumanInputDecision {
  readonly turn: TurnState;
  readonly signIns: readonly AuthorizationChallenge[];
  readonly commands: readonly Command[];
  /** Ephemeral callback facts, installed in the scoped tool context, never persisted. */
  readonly authorizations?: readonly Extract<
    FromHost,
    { readonly type: "authorization.resumed" }
  >[];
}

/** Arrivals are evaluated in originating suspended-step order, then the session's own/relayed requests. */
export function beforeStep(
  view: SessionView,
  arrivals: readonly BeforeStepArrival[],
  checkPolicy?: (check: PolicyCheck) => PolicyRun | undefined,
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
        (current.turn.hitl?.readsResults === true || current.turn.limitRequest !== undefined) &&
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
        current.turn.limitRequest === undefined
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
  return {
    turn: current.turn,
    signIns: current.signIns,
    commands,
    ...(authorizations.length > 0 && { authorizations }),
  };
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
  return { turn: current.turn, signIns: current.signIns, commands };
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
