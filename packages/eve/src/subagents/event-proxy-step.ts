import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import {
  publishFromSessionStep,
  restoreSessionStep,
  type PublishedSessionEvents,
  type RestoredSessionStep,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { applyTransition, sessionView } from "#harness/session-machine/commit.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { adaptHumanInput } from "#harness/hitl/index.js";
import { beforeStep, type BeforeStepArrival } from "#harness/hitl/index.js";
import type { WorkflowAskRoute } from "#harness/hitl/index.js";

type SubagentEventHookPayload =
  | SubagentAuthorizationEventHookPayload
  | SubagentInputRequestHookPayload;

/** Proxies one child event through its parent channel across a durable step boundary. */
export async function runProxySubagentEventStep(
  input: SessionStepState & {
    readonly workflowAsk?: WorkflowAskRoute;
    readonly runId?: string;
    readonly hookPayload: SubagentEventHookPayload;
  },
): Promise<SessionStateTransition> {
  "use step";

  return await withSessionStateDelta(input, async (target) =>
    emitProxiedSubagentEvent({
      ...(await restoreSessionStep(target)),
      workflowAsk: target.workflowAsk,
      runId: target.runId,
      hookPayload: target.hookPayload,
    }),
  );
}

/**
 * Relays one child event through the parent session's channel. `runId` names
 * the workflow tool run that relayed an input request, so the session can
 * withdraw it when that run ends.
 */
export async function emitProxiedSubagentEvent(
  input: RestoredSessionStep & {
    readonly workflowAsk?: WorkflowAskRoute;
    readonly runId?: string;
    readonly hookPayload: SubagentEventHookPayload;
  },
): Promise<PublishedSessionEvents> {
  const { ctx, hookPayload, runId, workflowAsk } = input;
  const { published } = await publishFromSessionStep(input, {
    origin: "relayed",
    inputSource:
      hookPayload.kind === "subagent-input-request"
        ? JSON.stringify([hookPayload.childContinuationToken, hookPayload.inputSource ?? null])
        : undefined,
    async publish(emit, session) {
      const view = sessionView(currentProjection(ctx), session.state);
      const arrival: BeforeStepArrival =
        hookPayload.kind === "subagent-input-request"
          ? {
              type: "relayed.requested",
              callId: hookPayload.callId,
              at: {
                sequence: hookPayload.event.sequence,
                stepIndex: hookPayload.event.stepIndex,
                turnId: hookPayload.event.turnId,
              },
              requests: hookPayload.event.requests,
              taskId: hookPayload.event.taskId,
              route: {
                childContinuationToken: hookPayload.childContinuationToken,
                ...(hookPayload.childSessionInbox?.sessionId === hookPayload.childSessionId && {
                  childSessionInbox: hookPayload.childSessionInbox,
                }),
                remote: hookPayload.remote,
                inputSource: hookPayload.inputSource,
                runId,
                control: workflowAsk?.control,
              },
            }
          : {
              type: "relayed.authorization",
              event: hookPayload.event,
              runId: runId ?? hookPayload.childSessionId,
            };
      const adapted = adaptHumanInput(view, beforeStep(view, [arrival]));
      if (adapted.effects.length !== 0)
        throw new TypeError("Relaying a child event must not send transport effects.");
      return await applyTransition(session, adapted.transition, emit);
    },
    updateSession(_session, applied) {
      return { session: applied };
    },
  });
  return published;
}
