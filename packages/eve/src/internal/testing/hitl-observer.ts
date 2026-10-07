import type { ModelMessage, UserContent } from "ai";
import type { SessionAuthContext } from "#channel/types.js";

import type { StepInput } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

import type { SessionView } from "#harness/session-machine/view.js";
import { projectHumanInput } from "#harness/hitl/projection.js";

import { askedCallIds, grantedApprovalKeys } from "#harness/hitl/approval.js";
import { candidateAuthorizationAttempts } from "#harness/hitl/approval-candidate.js";
import type { Next } from "#harness/hitl/command.js";
import { approvedCallsOf, heldCalls, type HeldCalls } from "#harness/hitl/held-step.js";
import type { RequestAt } from "#harness/hitl/input.js";
import { relayedRequestIds } from "#harness/hitl/relay.js";
import { awaitedAuthorizations } from "#harness/hitl/authorization.js";
import { staleAnswersAsText } from "#harness/hitl/input-stale-answer.js";
import { type HumanInputState, isOpenRelayed } from "#harness/hitl/state.js";
/** Read-only scenario assertions over the live SessionView; never reads legacy keys. */
export class HumanInput {
  readonly #state: HumanInputState;

  readonly #knownRequests?: ReadonlyMap<string, InputRequest>;

  private constructor(state: HumanInputState, knownRequests?: ReadonlyMap<string, InputRequest>) {
    this.#knownRequests = knownRequests;
    this.#state = state;
  }

  /** Project one originating step. Runtime persistence belongs exclusively to the session machine. */
  static fromView(view: SessionView, stepIndex = 0): HumanInput {
    return new HumanInput(
      projectHumanInput(view, view.turn.suspended[stepIndex]),
      new Map(
        Object.values(view.projection.inputs).map((entry) => [
          entry.request.requestId,
          entry.request,
        ]),
      ),
    );
  }

  /**
   * What the turn does now: run the calls a person approved (`approvedCalls`),
   * then commit what they did as `actions.settled`; run its next model step;
   * or wait. The model never
   * runs while a request of its own is open, authorizations included; a relayed
   * request waits on the call that asked, not on the model.
   */
  next(): Next {
    if (approvedCallsOf(this.#state.held) !== undefined) return { run: "approved" };
    return Object.values(this.#state.requests).some((open) => !isOpenRelayed(open))
      ? { waiting: "input" }
      : { run: "model" };
  }

  /**
   * The input a step runs with, once answers to closed budget questions are
   * dropped and answers to other requests that are no longer open become text
   * the model reads. `displayMessage` is that input's message as the person
   * sent it, for `message.received`.
   */
  acceptInput(input: StepInput | undefined): {
    readonly input: StepInput | undefined;
    readonly displayMessage?: string | UserContent;
  } {
    const open = this.openRequestIds();
    return staleAnswersAsText(input, open, this.#knownRequests);
  }

  /** Whether turn input waits for the turn's next step, behind calls that have joined history. */
  hasQueuedInput(): boolean {
    return this.#state.queued !== undefined;
  }

  /**
   * The held step's messages: the response of a step whose calls wait,
   * held out of history until each has a result. Tools that run for it read
   * them after history.
   */
  heldMessages(): readonly ModelMessage[] {
    return this.#state.held?.messages ?? [];
  }

  /**
   * The model step whose calls wait, out of history: each call without a
   * result, tagged with whether it waits on a person or on runtime work.
   */
  heldCalls(): HeldCalls | undefined {
    return heldCalls(this.#state.held, askedCallIds(this.#state));
  }

  /** The held step's calls that run as runtime work and have no result yet. */
  runtimeCalls(): HeldCalls | undefined {
    const held = this.heldCalls();
    return held?.calls.some((call) => call.waitsOn === "runtime") === true ? held : undefined;
  }

  /** The full auth of whoever approved a request, when it was allowed. */
  approverOfRequest(requestId: string): SessionAuthContext | undefined {
    return this.#state.audit?.settlements[requestId]?.approver;
  }

  /** The calls a person approved that the turn has yet to run, at the step that asked. */
  approvedCalls():
    | { readonly at: RequestAt; readonly requests: readonly InputRequest[] }
    | undefined {
    return approvedCallsOf(this.#state.held);
  }

  /** Whether the originating live step still holds a transcript. */
  holdsStep(): boolean {
    return this.#state.held !== undefined;
  }

  /** The approval keys `once()` approvals granted, which approval policies read. */
  grantedApprovalKeys(): ReadonlySet<string> {
    return grantedApprovalKeys(this.#state);
  }

  /** The authorization attempts whose callbacks the turn waits for, its responders' included. */
  awaitedAuthorizations(): readonly string[] {
    return [...awaitedAuthorizations(this.#state), ...candidateAuthorizationAttempts(this.#state)];
  }

  /**
   * Whether the session carries anything for a child or run: a relayed
   * request, or an authorization it started. Ending the run ends what it relayed.
   */
  relaysAnything(): boolean {
    return (
      this.relayedRequestIds().size > 0 ||
      Object.keys(this.#state.relayedAuthorizations ?? {}).length > 0
    );
  }

  /**
   * The ids of the open requests of this session's own that an answer can
   * resolve, for routing an answer to its turn. Authorizations are closed by their
   * callbacks instead, and relayed requests belong to whoever asked.
   */
  openRequestIds(): ReadonlySet<string> {
    return new Set(
      Object.entries(this.#state.requests).flatMap(([requestId, open]) =>
        open.kind === "authorization" || isOpenRelayed(open) ? [] : [requestId],
      ),
    );
  }

  /** Whether the open request is an approval, for attributing its response. */
  isApproval(requestId: string): boolean {
    return this.#state.requests[requestId]?.kind === "tool-approval";
  }

  /** The ids of the open relayed requests, whose answers a delivery may carry to who asked. */
  relayedRequestIds(): ReadonlySet<string> {
    return relayedRequestIds(this.#state);
  }

  /** How a message from the turn's own person steers the turn now. */
  steering(): Steering {
    return {
      interruptsGeneration: this.relayedRequestIds().size === 0,
      overridesQueue: "waiting" in this.next(),
    };
  }
}

/** How a message from the turn's own person steers the turn. */
export interface Steering {
  /**
   * The turn waits on them, so their message steers it whatever its turn
   * policy: queued, it would wait for a turn that can't end until they act.
   */
  readonly overridesQueue: boolean;
  /**
   * Their message may interrupt the model mid-generation. Not while a request
   * relayed through the session is open: the message may answer it, so it
   * waits for the step boundary that forwards it.
   */
  readonly interruptsGeneration: boolean;
}
