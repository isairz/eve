import { pendingPolicyChecks } from "./approval-candidate.js";
import { typedAnswers } from "./input-typed-reply.js";
import { projectHumanInput } from "./projection.js";
import { readAnswerText } from "#internal/input-text.js";
import { resolveInputOutcome } from "#harness/input-request-resolution.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import { buildResponseAuthorizationTools } from "#context/build-dynamic-tools.js";
import { collectDeferredCalls } from "#harness/coordination.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { stepStartedForResolvers } from "#harness/session-machine/resolver-events.js";
import { approvedCalls } from "#harness/session-machine/transitions.js";
import type { SuspendedStep } from "#harness/session-machine/view.js";
import { type Step } from "#harness/step/context.js";
import type { HarnessToolMap, StepInput, StepResult } from "#harness/types.js";
import { grantedApprovalKeys, deferInput } from "./approvals.js";
import { runApprovedCalls } from "./approved-calls.js";
import { deliver, turnInputOnly, withoutTurnInput, withoutResponses } from "./delivery.js";
import { approversOf, setApprovedCallCallers } from "./approved-call-callers.js";
import type { InstrumentationAttempt } from "#instrumentation/runtime.js";
import { beforeStep, afterStep, policyChecksBeforeStep } from "./decisions.js";
import { applyHumanInputDecision } from "./effects.js";
import { arrivalsOf } from "./input-arrival.js";
import { runPolicy } from "./policy-effect.js";
import { PendingAuthorizationResultKey } from "#harness/authorization.js";
import type { BeforeStepArrival } from "./decisions.js";
import type { Verdicts } from "./input.js";
import { activeTurnId } from "#harness/session-machine/view.js";

/**
 * What a delivery does before its turn runs. `stop` ends the step: the answers left nothing to
 * run yet, so the turn holds, or a responder must sign in first. `run` carries the turn's input,
 * without the answers the session took, and the approved work that runs once the turn opens.
 */
export type HumanInputIntake =
  | { readonly kind: "stop"; readonly result: StepResult }
  | {
      readonly kind: "run";
      readonly input: StepInput | undefined;
      /** The message the turn receives, as the stream shows it. */
      readonly message?: StepInput["message"];
      /** A plain-text answer consumed the message, so the model never reads it. */
      readonly consumedMessage: boolean;
      /** The delivery carries input for a turn. */
      readonly opensTurn: boolean;
      readonly approved: ApprovedWork;
    };

/**
 * What the delivery decided: the session-limit answer, and the tools approved calls run with.
 * The calls themselves wait in their suspended steps until the turn's next model step.
 */
export interface ApprovedWork {
  /** The tools a parked step's calls run with: those of the step that asked. */
  readonly toolsOf: (step: SuspendedStep | undefined) => HarnessToolMap;
}

/**
 * Answers what the session asked: approval answers pass the response policies, and the session
 * decides which parked steps they resolve. Runs before the delivery joins its turn, so approved
 * calls get the tools of the step that asked.
 */
export async function acceptHumanInput(
  step: Step,
  input: StepInput | undefined,
  options: { readonly takeQueued: boolean },
): Promise<HumanInputIntake> {
  const { config, ctx } = step;
  const starting = step.view();
  const takeQueued =
    options.takeQueued &&
    starting.turn.readsResults !== true &&
    starting.turn.limitRequest === undefined;
  const delivered = deliver(starting, input, { takeQueued });
  // The durable session boundary matched callbacks before entering the harness and removed
  // their challenges. Reconstruct the decision lens, without persisting an intermediate state.
  const completions = config.signInCompletions ?? [];
  const callbacks = ctx?.get(PendingAuthorizationResultKey) ?? [];
  const view = {
    ...starting,
    turn: takeQueued ? { ...starting.turn, queued: undefined } : starting.turn,
    signIns: [
      ...starting.signIns,
      ...completions.filter(
        (challenge) =>
          !starting.signIns.some(
            (open) => (open.attemptId ?? open.name) === (challenge.attemptId ?? challenge.name),
          ),
      ),
    ],
  };
  if (view.turn.audit !== undefined) {
    view.turn = {
      ...view.turn,
      audit: {
        ...view.turn.audit,
        activeCandidates: Object.fromEntries(
          Object.entries(view.turn.audit.activeCandidates).map(([id, candidate]) => {
            const authorizations = view.signIns.filter((challenge) => challenge.candidateId === id);
            return [
              id,
              candidate.authorizations !== undefined || authorizations.length === 0
                ? candidate
                : {
                    ...candidate,
                    status: "authorization-required" as const,
                    authorizations,
                  },
            ];
          }),
        ),
      },
    };
  }
  // Restoring a turn's tools runs its resolvers, so a step's tools are restored once, and again
  // only after another step's.
  const restoredTools = new Map<string, HarnessToolMap>();
  let restoredStep: string | undefined;
  const restoreTools = async (parked: SuspendedStep | undefined): Promise<HarnessToolMap> => {
    const at = parked?.event ?? step.position();
    const key = `${at.turnId}:${at.stepIndex}`;
    const restored = restoredTools.get(key);
    if (restored !== undefined && restoredStep === key) return restored;
    if (parked !== undefined) await config.prepareApprovalTurn?.(parked.event);
    if (ctx !== undefined) {
      await config.resolveStepDynamicTools?.({
        ctx,
        event: stepStartedForResolvers({
          modelId: step.session.agent.modelReference?.id ?? "dynamic",
          sequence: at.sequence,
          stepIndex: at.stepIndex,
          turnId: at.turnId,
        }),
        messages: step.projectHistory(step.session.history),
      });
    }
    const tools = buildResponseAuthorizationTools({ authoredTools: config.tools, context: ctx });
    restoredTools.set(key, tools);
    restoredStep = key;
    return tools;
  };
  const toolsOf = (parked: SuspendedStep | undefined) =>
    (parked && restoredTools.get(`${parked.event.turnId}:${parked.event.stepIndex}`)) ??
    config.tools;

  const sender = ctx?.get(AuthKey) ?? ctx?.get(SessionKey)?.auth.current ?? null;
  const waiting =
    starting.turn.limitRequest !== undefined ||
    starting.turn.readsResults === true ||
    starting.turn.suspended.some((parked) => parked.requests.length > 0) ||
    view.signIns.length > 0;
  const arrivals = arrivalsOf({
    now: Date.now(),
    sender,
    waiting,
    stepInput: delivered.input,
    callbacks: completions.map((challenge) => ({
      attemptId: challenge.attemptId ?? challenge.name,
      connectionName: challenge.name,
      callback: callbacks.find(
        (result) => (result.attemptId ?? result.name) === (challenge.attemptId ?? challenge.name),
      )?.callback,
    })),
  });
  const approvingIds = new Set(
    [
      ...(delivered.input?.inputResponses ?? []),
      ...(delivered.input?.attributedInputResponses ?? []).map((entry) => entry.response),
      ...view.turn.suspended.flatMap((parked) =>
        typedAnswers(projectHumanInput(view, parked), readAnswerText(delivered.input) ?? "", "own"),
      ),
    ]
      .filter((response) => response.optionId === "approve")
      .map((response) => response.requestId),
  );
  for (const parked of view.turn.suspended) {
    if (!parked.requests.some((request) => approvingIds.has(request.requestId))) continue;
    const tools = await restoreTools(parked);
    view.turn = {
      ...view.turn,
      suspended: view.turn.suspended.map((candidate) =>
        candidate !== parked
          ? candidate
          : {
              ...candidate,
              approvalKeys: Object.fromEntries(
                candidate.requests.map((request) => [
                  request.requestId,
                  tools.get(request.action.toolName)?.approvalKey?.(request.action.input) ??
                    candidate.approvalKeys?.[request.requestId] ??
                    request.action.toolName,
                ]),
              ),
            },
      ),
    };
  }
  const requestedChecks = policyChecksBeforeStep(view, arrivals);
  const dry = beforeStep(view, arrivals, () => undefined);
  const readyView = { ...view, turn: dry.turn, signIns: dry.signIns };
  const existing = new Set(Object.keys(starting.turn.audit?.activeCandidates ?? {}));
  const byId = new Map(
    readyView.turn.suspended
      .flatMap((parked) => pendingPolicyChecks(projectHumanInput(readyView, parked)))
      .filter((check) => existing.has(check.candidateId))
      .map((check) => [check.candidateId, check]),
  );
  for (const check of requestedChecks)
    if (existing.has(check.candidateId)) byId.set(check.candidateId, check);
  const checks = [...byId.values()];
  const verdicts: Record<string, Verdicts[string]> = {};
  for (const check of checks) {
    const parked = starting.turn.suspended.find(
      (candidate) =>
        candidate.event.turnId === check.at.turnId &&
        candidate.event.stepIndex === check.at.stepIndex,
    );
    verdicts[check.candidateId] = await runPolicy(check, await restoreTools(parked));
  }
  const checked: BeforeStepArrival[] = [
    ...arrivals,
    ...checks.map((check) => ({
      type: "policy.checked" as const,
      candidateId: check.candidateId,
      verdict: verdicts[check.candidateId]!,
    })),
  ];
  const decision = beforeStep(view, checked, (check) => verdicts[check.candidateId]);
  const resolved = decision.commands.flatMap((command) =>
    command.type === "publish" && command.event.type === "input.resolved" ? [command.event] : [],
  );
  for (const event of resolved) {
    await step.instrumentation?.publishInputResolutions({
      batch: {
        event: {
          sequence: event.data.sequence,
          stepIndex: event.data.stepIndex,
          turnId: event.data.turnId,
        },
        inputs: event.data.resolutions.flatMap((resolution) => {
          const request = Object.values(starting.projection.inputs).find(
            (entry) => entry.request.requestId === resolution.requestId,
          )?.request;
          return request === undefined
            ? []
            : [
                {
                  request,
                  response: resolution.response,
                  outcome: resolveInputOutcome(request.kind, resolution.response),
                },
              ];
        }),
      },
      sessionId: step.session.sessionId,
    });
  }
  await applyHumanInputDecision(step, decision);
  if (
    decision.commands.some(
      (command) => command.type === "declineBudget" || command.type === "cancelTurn",
    )
  )
    return { kind: "stop", result: { cancelled: true, next: null, session: step.session } };

  if (requestedChecks.some((check) => !existing.has(check.candidateId))) {
    const following = turnInputOnly(delivered.input);
    if (following !== undefined) await step.apply(deferInput(step.view(), following));
    return { kind: "stop", result: { next: step.runStep, session: step.session } };
  }
  for (const parked of step.view().turn.suspended) {
    if ((parked.approved?.length ?? 0) > 0) await restoreTools(parked);
  }
  const queuedAfterBudget = decision.commands.some((command) => command.type === "grantBudget")
    ? step.view().turn.queued
    : undefined;
  if (queuedAfterBudget !== undefined) {
    await step.apply({ turn: { ...step.view().turn, queued: undefined }, events: [] });
  }
  const consumedMessage =
    queuedAfterBudget === undefined &&
    decision.commands.some((command) => command.type === "consumeMessage");
  const answered = resolved.some(
    (event) =>
      event.data.resolutions.some((resolution) => resolution.kind === "tool-approval") &&
      event.data.resolutions.every((resolution) => resolution.response !== undefined),
  );
  const deferred =
    (answered || hasApprovedWork(step)) && !consumedMessage
      ? turnInputOnly(queuedAfterBudget ?? delivered.input)
      : undefined;
  if (deferred !== undefined) await step.apply(deferInput(step.view(), deferred));
  if (
    sender !== null &&
    delivered.input?.message === undefined &&
    resolved.some((event) =>
      event.data.resolutions.some((resolution) => resolution.kind === "tool-approval"),
    ) &&
    !hasApprovedWork(step)
  )
    return { kind: "stop", result: { next: step.runStep, session: step.session } };
  const remaining =
    queuedAfterBudget ??
    (consumedMessage ? withoutTurnInput(delivered.input) : withoutResponses(delivered.input));
  const barrierQueued =
    starting.turn.readsResults === true ||
    (step.view().turn.limitRequest !== undefined && !consumedMessage);
  const turnInput =
    deferred !== undefined || barrierQueued ? withoutTurnInput(remaining) : remaining;
  const pending =
    step.view().turn.limitRequest !== undefined ||
    step.view().signIns.length > 0 ||
    step.view().turn.suspended.some((parked) => parked.requests.length > 0);
  if (pending && !hasApprovedWork(step))
    return {
      kind: "stop",
      result:
        starting.projection.activeTurnId === undefined
          ? { next: null, session: step.session }
          : await holdForInput(step),
    };
  return {
    approved: { toolsOf },
    consumedMessage,
    input: turnInput,
    message:
      consumedMessage || deferred !== undefined || barrierQueued
        ? undefined
        : (queuedAfterBudget?.message ?? delivered.displayMessage ?? delivered.input?.message),
    kind: "run",
    opensTurn: !barrierQueued && (hasTurnInput(delivered.input) || completions.length > 0),
  };
}

/**
 * Admits what a delivery decided before its turn calls the model: a session-limit answer grants a
 * fresh budget or ends the turn tree, and a step its answers completed, as denials do, commits.
 */
export async function admitApprovedWork(step: Step, _work: ApprovedWork): Promise<void> {
  for (const parked of step.view().turn.suspended) {
    await applyHumanInputDecision(
      step,
      afterStep(step.view(), { type: "actions.settled", at: parked.event, results: [] }),
    );
  }
}

/** Whether a suspended step holds approved calls that haven't run. */
export function hasApprovedWork(step: Step): boolean {
  return approvedCalls(step.view().turn).length > 0;
}

/**
 * Approved workflow and agent calls join the runs their steps wait on, once the step has started
 * and before its budget check. Returns whether any did: the turn then waits on the runtime, and
 * approved local calls run after their results arrive.
 */
export async function dispatchApprovedWorkflows(step: Step, work: ApprovedWork): Promise<boolean> {
  let dispatched = false;
  for (const parked of step.view().turn.suspended) {
    const tools = work.toolsOf(parked);
    const requests = (parked.approved ?? []).filter(
      (request) => tools.get(request.action.toolName)?.workflowId !== undefined,
    );
    if (requests.length === 0) continue;
    const deferred = collectDeferredCalls({
      session: step.session,
      toolCalls: requests.map(({ action }) => ({
        input: action.input,
        toolCallId: action.callId,
        toolName: action.toolName,
      })),
      tools,
      turnId: parked.event.turnId,
    });
    step.session = deferred.session;
    await applyHumanInputDecision(
      step,
      afterStep(step.view(), {
        type: "actions.settled",
        at: parked.event,
        results: [],
        running: deferred.workflowRequests,
        runningApprovers: approversOf(requests, step.view()),
        approved: { callIds: requests.map((request) => request.action.callId) },
      }),
    );
    dispatched = true;
  }
  return dispatched;
}

/**
 * Runs approved local calls once the step has started and its budget allows it, as the AI SDK ran
 * them before the model read their results: each with the tools of the step that asked, as
 * whoever approved it, and in the step's first attempt. A call that needs a sign-in holds the
 * turn.
 */
export async function runApprovedLocalCalls(
  step: Step,
  work: ApprovedWork,
  setAttemptScope: (scope: InstrumentationAttempt | undefined) => void,
): Promise<StepResult | undefined> {
  const local = step.view().turn.suspended.map((parked) => {
    const tools = work.toolsOf(parked);
    const requests = (parked.approved ?? []).filter(
      (request) => tools.get(request.action.toolName)?.workflowId === undefined,
    );
    return { parked, requests, tools };
  });
  const approved = local.flatMap(({ requests }) => requests);
  step.frameworkToolNames = new Set(
    local.flatMap(({ tools }) =>
      [...tools].filter(([, tool]) => tool.frameworkTool === true).map(([name]) => name),
    ),
  );
  setApprovedCallCallers(approved, step.view());
  const position = step.position();
  const attempt =
    approved.length === 0
      ? undefined
      : step.instrumentation?.prepareAttempt({
          isFrameworkTool: (name) => step.frameworkToolNames.has(name),
          attemptIndex: 0,
          stepIndex: position.stepIndex,
          turnId: activeTurnId(position),
        });
  if (attempt !== undefined) setAttemptScope(attempt.scope);
  const executed = await Promise.all(
    local.map(async ({ requests, tools }) => {
      if (requests.length === 0) return { settled: [], toolResults: [] };
      return await runApprovedCalls({
        abortSignal: step.config.abortSignal,
        approvedTools: grantedApprovalKeys(step.view(), (request) =>
          tools.get(request.action.toolName)?.approvalKey?.(request.action.input),
        ),
        messages: step.projectHistory(step.session.history),
        position: step.position(),
        publish: step.publish,
        requests,
        telemetry: attempt?.telemetry,
        tools,
      });
    }),
  );
  let needsSignIn = false;
  for (const [index, run] of executed.entries()) {
    const { parked, requests } = local[index]!;
    if (requests.length === 0) continue;
    const signIn = resolveInlineAuthorizationInterrupt({
      messages: [],
      toolResults: run.toolResults,
    });
    await applyHumanInputDecision(
      step,
      afterStep(step.view(), {
        type: "actions.settled",
        at: parked.event,
        results:
          run.settled.length === 0
            ? []
            : [{ role: "tool", content: run.settled.map((result) => result.part) }],
        approved: { callIds: requests.map((request) => request.action.callId) },
        ...(signIn !== undefined && {
          authorizations: {
            callIds: [...signIn.callIdsByName.values()].flat(),
            challenges: signIn.challenges,
          },
        }),
      }),
    );
    needsSignIn ||= signIn !== undefined;
  }
  return needsSignIn ? await holdForInput(step) : undefined;
}

/**
 * The held turn holds on, for a person to act on its sign-in, approval, or the session-limit
 * prompt; the session resumes it when they do.
 */
export async function holdForInput(step: Step): Promise<StepResult> {
  await applyHumanInputDecision(step, beforeStep(step.view(), [{ type: "turn.waiting" }]));
  return held(step);
}

function held(step: Step): StepResult {
  return { held: { kind: "request" }, next: null, session: step.session };
}

/** Whether the input carries user-facing turn input. */
function hasTurnInput(input: StepInput | undefined): boolean {
  if (input === undefined) return false;
  return input.message !== undefined || (input.inputResponses?.length ?? 0) > 0;
}
