import type {
  PublishedSessionEvents,
  SessionStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { commitSessionStep } from "#execution/session/human-input-step.js";

/**
 * Decides a run's request to withdraw a question. A question the session
 * still offers is withdrawn, so channels stop offering it. One it no longer
 * offers was already answered or withdrawn when its turn was cancelled. Either
 * way the run hears `withdrawn`, after any answer the session sent it first, so
 * the question resolves from the session's first decision.
 */
export async function withdrawWorkflowToolRunQuestionStep(
  input: WithdrawQuestionInput,
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, withdrawWorkflowToolRunQuestion);
}

type WithdrawQuestionInput = SessionStepState & {
  readonly control: string;
  readonly requestId: string;
  readonly runId: string;
};

async function withdrawWorkflowToolRunQuestion(
  input: WithdrawQuestionInput,
): Promise<PublishedSessionEvents> {
  return await commitSessionStep(input, [
    {
      type: "relayed.withdrawn",
      control: input.control,
      requestId: input.requestId,
      runId: input.runId,
    },
  ]);
}

/**
 * Withdraws the requests a finished run left open: its own questions and those
 * of the sessions it opened, which ended with it. Nobody can answer them now.
 */
export async function withdrawFinishedRunQuestionsStep(
  input: SessionStepState & { readonly runId: string },
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, (target) =>
    commitSessionStep(target, [{ type: "run.ended", runId: target.runId }]),
  );
}
