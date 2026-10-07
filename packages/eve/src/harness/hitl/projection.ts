import { hitlStepKey } from "./record.js";
import { readClientContext } from "#internal/client-context.js";
import { openInputs } from "#protocol/session-projection.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import type { InputRequest } from "#shared/input.js";
import type {
  SessionView,
  StepCoordinates,
  SuspendedStep,
  TurnState,
} from "#harness/session-machine/view.js";
import { turnPosition } from "#harness/session-machine/view.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { HumanInputState, HeldStep, OpenApproval } from "./state.js";

export function sameStep(left: StepCoordinates, right: StepCoordinates): boolean {
  return (
    left.turnId === right.turnId &&
    left.sequence === right.sequence &&
    left.stepIndex === right.stepIndex
  );
}

/** A rule's singular held step is a lens onto one member, never the whole suspended array. */
export function projectHumanInput(view: SessionView, step?: SuspendedStep): HumanInputState {
  const requests: Record<string, HumanInputState["requests"][string]> = {};
  if (step !== undefined) {
    const record = view.turn.hitl?.steps?.[hitlStepKey(step.event)];
    for (const request of step.requests) {
      const approval: OpenApproval = {
        kind: "tool-approval",
        at: step.event,
        request,
        requester: step.requester ?? null,
        approvalKey: record?.approvalKeys?.[request.requestId] ?? request.action.toolName,
        ...(record?.answers?.[request.requestId] !== undefined && {
          answer: record.answers[request.requestId],
        }),
        ...(step.responseAuthRequiredRequestIds?.includes(request.requestId) && {
          responsePolicy: true,
        }),
      };
      requests[request.requestId] = approval;
    }
  }
  for (const challenge of view.signIns) {
    if (challenge.candidateId !== undefined) continue;
    const key = challenge.attemptId ?? challenge.name;
    const at = view.projection.authorizations[key] ?? turnPosition(view.projection);
    if (step !== undefined && !sameStep(at, step.event)) continue;
    if (step === undefined && view.turn.suspended.some((held) => sameStep(at, held.event)))
      continue;
    requests[key] = { kind: "authorization", at, challenge };
  }
  if (step === undefined) {
    for (const input of Object.values(view.projection.inputs)) {
      if (input.status === "settled") continue;
      const route = view.turn.hitl?.relayedRoutes?.[input.request.requestId];
      if (route !== undefined)
        requests[input.request.requestId] = {
          kind: "relayed",
          at: input,
          request: input.request,
          route,
        };
      else if (input.request.kind === "session-limit") {
        requests[input.request.requestId] = {
          kind: "session-limit",
          at: input,
          request: input.request,
        };
      }
    }
  }
  const held: HeldStep | undefined =
    step === undefined ||
    (step.transcriptCommitted === true && step.tasks.length === 0 && step.approved === undefined)
      ? undefined
      : {
          at: step.event,
          messages: step.messages,
          runtime: { tasks: step.tasks, approvers: step.approvers },
          ...(step.approved !== undefined && { approved: step.approved }),
          ...(step.following !== undefined && { following: step.following }),
        };
  const audit = view.turn.hitl?.audit;
  return {
    requests,
    grants: view.turn.grants,
    queued: view.turn.queued,
    held,
    ...(audit !== undefined && {
      audit: {
        ...audit,
        activeCandidates: Object.fromEntries(
          Object.entries(audit.activeCandidates).filter(
            ([, candidate]) => candidate.requestId in requests,
          ),
        ),
      },
    }),
    relayedAuthorizations: view.turn.hitl?.relayedAuthorizations,
  };
}

/** Fold the rule lens back into execution metadata; only applyTransition persists it. */
export function projectedTurn(
  view: SessionView,
  state: HumanInputState,
  at?: StepCoordinates,
): TurnState {
  const approvals = Object.values(state.requests).filter(
    (request): request is OpenApproval => request.kind === "tool-approval",
  );
  const suspended = [...view.turn.suspended];
  const steps = { ...view.turn.hitl?.steps };
  if (at !== undefined) {
    const key = hitlStepKey(at);
    if (approvals.length === 0) delete steps[key];
    else
      steps[key] = {
        approvalKeys: Object.fromEntries(
          approvals.map((approval) => [approval.request.requestId, approval.approvalKey]),
        ),
        answers: Object.fromEntries(
          approvals.flatMap((approval) =>
            approval.answer === undefined ? [] : [[approval.request.requestId, approval.answer]],
          ),
        ),
      };
  }
  if (at !== undefined) {
    const index = suspended.findIndex((step) => sameStep(step.event, at));
    if (state.held === undefined) {
      if (index >= 0) suspended.splice(index, 1);
    } else {
      const previous = index < 0 ? undefined : suspended[index];
      const next: SuspendedStep = {
        ...previous,
        event: at,
        messages: state.held.messages,
        requests: approvals.map((approval) => approval.request),
        tasks: state.held.runtime?.tasks ?? [],
        approvers: state.held.runtime?.approvers,
        approved: state.held.approved,
        following: state.held.following,
        requester: approvals[0]?.requester ?? previous?.requester,
        responseAuthRequiredRequestIds: approvals
          .filter((approval) => approval.responsePolicy === true)
          .map((approval) => approval.request.requestId),
      };
      if (index < 0) suspended.push(next);
      else suspended[index] = next;
    }
  }
  const prior = projectHumanInput(
    view,
    at === undefined ? undefined : view.turn.suspended.find((step) => sameStep(step.event, at)),
  );
  const activeCandidates = { ...view.turn.hitl?.audit?.activeCandidates };
  for (const id of Object.keys(prior.audit?.activeCandidates ?? {})) delete activeCandidates[id];
  Object.assign(activeCandidates, state.audit?.activeCandidates);
  const audit = state.audit === undefined ? undefined : { ...state.audit, activeCandidates };
  return {
    ...view.turn,
    suspended,
    grants: state.grants,
    queued: state.queued,
    hitl: {
      ...view.turn.hitl,
      steps,
      audit,
      ...(at === undefined && {
        relayedRoutes: Object.fromEntries(
          Object.entries(state.requests).flatMap(([id, request]) =>
            request.kind === "relayed" ? [[id, request.route]] : [],
          ),
        ),
        relayedAuthorizations: state.relayedAuthorizations,
      }),
    },
  };
}

export function projectedSignIns(
  view: SessionView,
  before: HumanInputState,
  after: HumanInputState,
): readonly AuthorizationChallenge[] {
  const removed = new Set(
    Object.entries(before.requests)
      .filter(([, request]) => request.kind === "authorization")
      .map(([id]) => id),
  );
  for (const candidate of Object.values(before.audit?.activeCandidates ?? {}))
    for (const challenge of candidate.authorizations ?? [])
      removed.add(challenge.attemptId ?? challenge.name);
  const remaining = view.signIns.filter(
    (challenge) => !removed.has(challenge.attemptId ?? challenge.name),
  );
  const added = Object.values(after.requests).flatMap((request) =>
    request.kind === "authorization" ? [request.challenge] : [],
  );
  added.push(
    ...Object.values(after.audit?.activeCandidates ?? {}).flatMap(
      (candidate) => candidate.authorizations ?? [],
    ),
  );
  return [...remaining, ...added];
}

/** Queued input that can run now, rather than wait for more answers. */
export function hasRunnableQueue(view: SessionView): boolean {
  const queued = view.turn.queued;
  if (queued === undefined) return false;
  if (
    queued.message !== undefined ||
    (queued.context?.length ?? 0) > 0 ||
    readClientContext(queued) !== undefined ||
    queued.outputSchema !== undefined ||
    (queued.runtimeActionResults?.length ?? 0) > 0
  ) {
    return true;
  }
  const responses = [
    ...(queued.inputResponses ?? []),
    ...(queued.attributedInputResponses ?? []).map(({ response }) => response),
  ];
  if (responses.length === 0) return false;
  const answered = new Set(responses.map((response) => response.requestId));
  const limit = openInputs(view.projection).find((open) => open.request.kind === "session-limit");
  if (limit !== undefined) return answered.has(limit.request.requestId);
  return view.turn.suspended.some(
    (step) =>
      step.requests.length > 0 && step.requests.every((request) => answered.has(request.requestId)),
  );
}

/** Keys `once()` approvals granted, except those a pending approval still asks about. */
export function grantedApprovalKeys(
  view: SessionView,
  approvalKey: (request: InputRequest) => string | undefined,
): ReadonlySet<string> {
  const granted = new Set(view.turn.grants);
  for (const step of view.turn.suspended) {
    for (const request of step.requests) {
      if (isApprovalRequest(request))
        granted.delete(approvalKey(request) ?? request.action.toolName);
    }
  }
  return granted;
}
