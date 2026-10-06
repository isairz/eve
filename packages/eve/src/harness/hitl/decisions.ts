import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionView, StepCoordinates, TurnState } from "#harness/session-machine/view.js";
import { foldSession } from "#protocol/session-projection.js";
import type { Command } from "./command.js";
import type { FromStep, FromInbox, FromRelay, FromHost } from "./input.js";
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
}

/** Arrivals are evaluated in originating suspended-step order, then the session's own/relayed requests. */
export function beforeStep(
  view: SessionView,
  arrivals: readonly BeforeStepArrival[],
): HumanInputDecision {
  let current = view;
  const commands: Command[] = [];
  for (const step of [...view.turn.suspended, undefined]) {
    for (const arrival of arrivals) {
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
      if (current.turn.readsResults === true && arrival.type === "message.received") {
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
        current.turn.readsResults === true &&
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
      const reduced = reduce(before, input, parked ? "parked" : "pre-step", verdictsOf(input));
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
  return { turn: current.turn, signIns: current.signIns, commands };
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
      ? { ...view, turn: { ...view.turn, readsResults: undefined } }
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
