import { expect, it } from "vitest";
import { sessionView } from "#harness/session-machine/commit.js";
import { hydrateMachineState } from "#harness/session-machine/hydrate.js";
import { initialSessionProjection } from "#protocol/session-projection.js";
import { ALICE as alice, AT, approval, stepResponse } from "#internal/testing/hitl.js";
import { approversOf } from "./approved-call-callers.js";
import { beforeStep } from "./decisions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { createApprovalCandidate, settleDirectApprovalResponse } from "./candidates.js";

const at = { sequence: 1, stepIndex: 0, turnId: "t1" };
const request = {
  kind: "tool-approval" as const,
  requestId: "r1",
  prompt: "Approve deploy?",
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  action: { kind: "tool-call" as const, callId: "c1", toolName: "deploy", input: {} },
};
const turn = {
  grants: [],
  suspended: [{ event: at, messages: [], requests: [request], requester: alice, tasks: [] }],
};
const audit = {
  activeCandidates: {},
  candidateHistory: [],
  nextCandidateSequence: 3,
  settlements: {
    r1: { actor: alice, approver: alice, outcome: "allowed", requestId: "r1", settledAt: 123 },
  },
};
function savedSession() {
  return {
    state: {
      "eve.harness.turnState": {
        ...turn,
        suspended: [{ ...turn.suspended[0], requests: [], approved: [request] }],
      },
      "eve.runtime.hitl.approvalState": audit,
    },
  };
}
it("preserves Owen's persisted approval audit on hydration", () => {
  const saved = hydrateMachineState(savedSession());
  expect(
    sessionView(initialSessionProjection(), saved.state).turn.audit?.settlements.r1?.approver,
  ).toEqual(alice);
  expect(saved.state["eve.runtime.hitl.approvalState"]).toBeUndefined();
});
it("resumes an approved call as its approver and hydrates idempotently", () => {
  const saved = hydrateMachineState(savedSession());
  const view = sessionView(initialSessionProjection(), saved.state);
  expect(approversOf(view.turn.suspended[0]!.approved!, view)).toEqual({ c1: alice });
  expect(hydrateMachineState(saved)).toEqual(saved);
});
it("removes the old approval key in the hydration write", () => {
  expect(hydrateMachineState(savedSession()).state).not.toHaveProperty(
    "eve.runtime.hitl.approvalState",
  );
});
it("maps candidate challenges, retains history, and lets machine audit win duplicates", () => {
  const candidate = {
    candidateId: "candidate",
    requestId: "r2",
    createdAt: 1,
    expiresAt: 100,
    responder: alice,
    decision: "approve" as const,
    status: "authorization-required" as const,
    authorizationChallenges: [{ name: "github", candidateId: "candidate" }],
  };
  const history = {
    ...candidate,
    candidateId: "finished",
    status: "allowed" as const,
    completedAt: 2,
  };
  const saved = hydrateMachineState({
    state: {
      ...savedSession().state,
      "eve.runtime.hitl.approvalState": {
        ...audit,
        activeCandidates: { candidate },
        candidateHistory: [history],
      },
    },
  });
  const upgraded = sessionView(initialSessionProjection(), saved.state).turn.audit!;
  expect(upgraded.activeCandidates.candidate?.authorizations).toEqual(
    candidate.authorizationChallenges,
  );
  expect(upgraded.candidateHistory).toEqual([history]);
  expect(upgraded.nextCandidateSequence).toBe(3);
  const mixed = hydrateMachineState({
    state: {
      ...saved.state,
      "eve.runtime.hitl.approvalState": {
        ...audit,
        settlements: {
          r1: { ...audit.settlements.r1, approver: undefined },
          r2: { ...audit.settlements.r1, requestId: "r2" },
        },
        nextCandidateSequence: 99,
      },
    },
  });
  const merged = sessionView(initialSessionProjection(), mixed.state).turn.audit!;
  expect(merged.settlements.r1?.approver).toEqual(alice);
  expect(merged.settlements.r2?.approver).toEqual(alice);
  expect(merged.candidateHistory).toEqual([history]);
  expect(merged.nextCandidateSequence).toBe(3);
  expect(hydrateMachineState(mixed)).toEqual(mixed);
});
it("never writes the old approval key back during a resumed turn", () => {
  const resumed = hydrateMachineState(savedSession()).state;
  const candidate = createApprovalCandidate({
    candidateIdPrefix: "c",
    createdAt: 200,
    decision: "approve",
    expiresAt: 1_000,
    requestId: "r2",
    responder: alice,
    state: resumed,
  });
  expect(candidate.changed).toBe(true);
  expect(candidate.state).not.toHaveProperty("eve.runtime.hitl.approvalState");
  const settled = settleDirectApprovalResponse({
    actor: alice,
    outcome: "allowed",
    requestId: "r3",
    settledAt: 300,
    state: candidate.state,
  });
  expect(settled.state).not.toHaveProperty("eve.runtime.hitl.approvalState");
  const audit = sessionView(initialSessionProjection(), settled.state).turn.audit!;
  expect(audit.settlements.r1?.approver).toEqual(alice);
  expect(audit.settlements.r3?.approver).toEqual(alice);
  // A session with no turn state yet writes into the turn's audit too.
  const fresh = settleDirectApprovalResponse({
    actor: alice,
    outcome: "allowed",
    requestId: "r4",
    settledAt: 400,
    state: {},
  });
  expect(fresh.state).not.toHaveProperty("eve.runtime.hitl.approvalState");
  expect(
    sessionView(initialSessionProjection(), fresh.state).turn.audit?.settlements.r4?.approver,
  ).toEqual(alice);
});
it.each(["allowed", "cancelled"] as const)(
  "upgrades a %s settlement whose answer hadn't reached its step, once",
  (outcome) => {
    const gated = approval("deploy");
    const saved = hydrateMachineState({
      state: {
        "eve.harness.turnState": {
          grants: [],
          suspended: [
            {
              event: AT,
              messages: stepResponse([gated]),
              requests: [gated],
              requester: alice,
              tasks: [],
            },
          ],
        },
        "eve.runtime.hitl.approvalState": {
          activeCandidates: {},
          candidateHistory: [],
          nextCandidateSequence: 1,
          settlements: {
            [gated.requestId]: {
              actor: alice,
              ...(outcome === "allowed" && { approver: alice }),
              outcome,
              requestId: gated.requestId,
              settledAt: 100,
            },
          },
        },
      },
    });
    expect(hydrateMachineState(saved)).toEqual(saved);
    const view = sessionView(storedProjection(saved.state), saved.state);
    const decision = beforeStep(view, [{ type: "time", now: 101 }]);
    expect(decision.turn.suspended.flatMap((step) => step.requests)).toEqual([]);
    if (outcome === "allowed") {
      expect(decision.turn.suspended[0]?.approved).toEqual([gated]);
      expect(
        approversOf(decision.turn.suspended[0]!.approved!, { ...view, turn: decision.turn }),
      ).toEqual({ [gated.action.callId]: alice });
    }
  },
);
