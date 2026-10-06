import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import type { HarnessSession } from "#harness/types.js";
import { applyTransition, sessionView } from "#harness/session-machine/commit.js";
import { readTurnState } from "#harness/session-machine/state.js";
import type { SessionView } from "#harness/session-machine/view.js";
import {
  createTurnStartedEvent,
  createInputRequestedEvent,
  createInputResolvedEvent,
} from "#protocol/message.js";
import { foldSession, initialSessionProjection } from "#protocol/session-projection.js";
import {
  ALICE,
  AT,
  BUDGET_QUESTION,
  approval,
  approvalsRequested,
  answers,
  answer,
  challenge,
  message,
  stepResponse,
} from "#internal/testing/hitl.js";
import { adaptHumanInput } from "./adapter.js";
import { beforeStep, afterStep, type HumanInputDecision } from "./decisions.js";
import { legacyProjection, projectHumanInput } from "./projection.js";
import { LEGACY_BATCH_KEY, LEGACY_GRANTS_KEY, STATE_KEY } from "./state.js";
import type { Command } from "./command.js";
import { reduce } from "./reducer.js";

function view(): SessionView {
  return {
    projection: foldSession(initialSessionProjection(), createTurnStartedEvent(AT)),
    turn: { grants: [], suspended: [] },
    relayedRequestIds: new Set(),
    signIns: [],
    usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 12, outputTokens: 3 },
  };
}
function decision(v: SessionView, commands: readonly Command[]): HumanInputDecision {
  return { turn: v.turn, signIns: v.signIns, commands };
}
function adapt(commands: readonly Command[], v = view()) {
  return adaptHumanInput(v, decision(v, commands));
}
function session(): HarnessSession {
  return {
    sessionId: "s",
    continuationToken: "http:test",
    agent: { modelReference: { id: "test" }, system: "test", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100000 },
    history: [],
    limits: { maxInputTokensPerSession: 100 },
  };
}
const text: ModelMessage = { role: "user", content: "hello" };
const route = { childContinuationToken: "child" };
const effectResult = {
  name: "github",
  attemptId: "attempt",
  hookUrl: "https://example.test/hook",
  callback: { params: {}, method: "GET" as const },
};

// Adding a Command variant requires both the adapter switch and this coverage table to change.
const examples = {
  publish: {
    type: "publish",
    event: createInputRequestedEvent({ ...AT, requests: [approval("a")] }),
    relayed: true,
  },
  appendHistory: { type: "appendHistory", message: text },
  resumeInput: { type: "resumeInput", input: { message: "next" } },
  consumeMessage: { type: "consumeMessage" },
  resumeAuthorization: { type: "resumeAuthorization", requester: ALICE, result: effectResult },
  forwardAnswer: {
    type: "forwardAnswer",
    route,
    responses: [{ requestId: "a", optionId: "approve" }],
  },
  withdrawQuestion: { type: "withdrawQuestion", control: "control", requestId: "a" },
  waitTurn: { type: "waitTurn" },
  grantBudget: { type: "grantBudget" },
  declineBudget: { type: "declineBudget", requestId: "limit" },
  addNote: { type: "addNote", text: "note" },
  cancelTurn: { type: "cancelTurn" },
} satisfies { [T in Command["type"]]: Extract<Command, { type: T }> };

describe("HumanInput adapter", () => {
  it.each(Object.entries(examples))("maps %s without executing effects", (name, command) => {
    const original = {
      ...view(),
      turn: { ...view().turn, queued: { message: "old", context: ["existing"] } },
    };
    const { transition, effects } = adapt([command], original);
    switch (name) {
      case "publish":
        expect(transition.events).toEqual([examples.publish.event]);
        break;
      case "appendHistory":
        expect(transition.commit).toEqual([text]);
        expect(transition.turn.readsResults).toBe(true);
        break;
      case "resumeInput":
        expect(transition.turn.queued).toEqual({ message: "next" });
        break;
      case "consumeMessage":
        expect(transition.turn.queued).toEqual({ context: ["existing"] });
        break;
      case "addNote":
        expect(transition.turn.queued).toEqual({ message: "old", context: ["existing", "note"] });
        break;
      case "grantBudget":
        expect(transition.grantBudget).toBe(true);
        break;
      case "waitTurn":
        expect(transition.events.map((event) => event.type)).toEqual(["turn.waiting"]);
        break;
      case "cancelTurn":
      case "declineBudget":
        expect(transition.events.map((event) => event.type)).toEqual([
          "turn.cancelled",
          "session.waiting",
        ]);
        break;
      default:
        expect(effects).toEqual([command]);
        return;
    }
    expect(effects).toEqual([]);
  });

  it("publishes and persists the transition before a scripted caller dispatches the ordered outbox", async () => {
    const adapted = adapt([
      examples.forwardAnswer,
      examples.publish,
      examples.withdrawQuestion,
      examples.resumeAuthorization,
    ]);
    const order: string[] = [];
    let saved = session();
    saved = await applyTransition(
      saved,
      { ...adapted.transition, turn: { ...adapted.transition.turn, grants: ["proof"] } },
      async (event) => {
        order.push(event.type);
      },
    );
    for (const effect of adapted.effects) {
      expect(readTurnState(saved.state).grants).toEqual(["proof"]);
      order.push(effect.type);
    }
    expect(order).toEqual([
      "input.requested",
      "forwardAnswer",
      "withdrawQuestion",
      "resumeAuthorization",
    ]);
  });

  it("folds input commands and events in original order", () => {
    const first = examples.publish.event;
    const second = createInputResolvedEvent({
      ...AT,
      resolutions: [{ requestId: "a", kind: "tool-approval", outcome: "approved" }],
    });
    const result = adapt([
      { type: "publish", event: first },
      examples.resumeInput,
      examples.addNote,
      examples.consumeMessage,
      { type: "publish", event: second },
      examples.waitTurn,
    ]);
    expect(result.transition.events.map((event) => event.type)).toEqual([
      "input.requested",
      "input.resolved",
      "turn.waiting",
    ]);
    expect(result.transition.turn.queued).toEqual({ context: ["note"] });
  });

  it("uses the machine cancel after already published resolutions without withdrawing them twice", () => {
    const request = approval("a");
    const base = view();
    const v = {
      ...base,
      projection: foldSession(
        base.projection,
        createInputRequestedEvent({ ...AT, requests: [request] }),
      ),
    };
    const result = adapt(
      [
        {
          type: "publish",
          event: createInputResolvedEvent({
            ...AT,
            resolutions: [{ requestId: "a", kind: "tool-approval", outcome: "cancelled" }],
          }),
        },
        examples.cancelTurn,
      ],
      v,
    );
    expect(result.transition.events.map((event) => event.type)).toEqual([
      "input.resolved",
      "turn.cancelled",
      "session.waiting",
    ]);
  });

  it("records budget grants through machine apply, leaving the source session untouched", async () => {
    const original = session();
    const applied = await applyTransition(
      original,
      adapt([examples.grantBudget]).transition,
      async () => {},
    );
    expect(original.state).toBeUndefined();
    expect(applied.state?.["eve.harness.sessionRuntimeTokenLimit"]).toEqual({ inputTokens: 100 });
  });

  it("aggregates multiple suspended steps in suspended-array order, not answer order", () => {
    let v = view();
    for (const [stepIndex, name] of [
      [0, "a"],
      [1, "b"],
    ] as const) {
      const response = approvalsRequested([approval(name)], { at: { ...AT, stepIndex } });
      const next = afterStep(v, response);
      const adapted = adaptHumanInput(v, next);
      v = {
        ...v,
        turn: adapted.transition.turn,
        projection: adapted.transition.events.reduce(foldSession, v.projection),
        signIns: next.signIns,
      };
    }
    const next = beforeStep(v, [answers({ b: "approve", a: "approve" })]);
    const events = adaptHumanInput(v, next).transition.events;
    expect(
      events
        .filter((event) => event.type === "input.resolved")
        .map((event) => event.data.stepIndex),
    ).toEqual([0, 1]);
    expect(
      next.turn.suspended.map((step) => step.approved?.map((request) => request.requestId)),
    ).toEqual([["a"], ["b"]]);
    expect(next.turn.grants).toEqual(["a", "b"]);
  });

  it("reconstructs each held lens solely from persisted TurnState after restart", async () => {
    let v = view();
    const a = approval("a");
    const b = approval("b");
    const next = afterStep(
      v,
      approvalsRequested([a, b], { approvalKeys: { a: "a-key" }, responsePolicyRequestIds: ["a"] }),
    );
    const stored = await applyTransition(
      session(),
      adaptHumanInput(v, next).transition,
      async () => {},
    );
    const restarted = sessionView(
      initialSessionProjection(),
      JSON.parse(JSON.stringify(stored.state)),
    );
    const projected = projectHumanInput(restarted, restarted.turn.suspended[0]);
    expect(projected.held?.messages).toEqual(stepResponse([a, b]));
    expect(projected.requests.a).toMatchObject({
      approvalKey: "a-key",
      responsePolicy: true,
      requester: ALICE,
    });
    expect(projected.requests.b).toMatchObject({ approvalKey: "b" });
    expect(stored.state?.[STATE_KEY]).toBeUndefined();
  });

  it("preserves partial answers and candidate audit across a restart", async () => {
    const v = view();
    const opened = afterStep(v, approvalsRequested([approval("a"), approval("b")]));
    const waiting = { ...v, turn: opened.turn };
    const answered = beforeStep(waiting, [answer("approve", "a")]);
    const stored = await applyTransition(
      session(),
      adaptHumanInput(waiting, answered).transition,
      async () => {},
    );
    const restart = sessionView(
      initialSessionProjection(),
      JSON.parse(JSON.stringify(stored.state)),
    );
    expect(projectHumanInput(restart, restart.turn.suspended[0]).requests.a).toMatchObject({
      answer: { requestId: "a", optionId: "approve" },
    });
    expect(restart.turn.audit?.settlements.a?.approver).toEqual(ALICE);
    const finished = beforeStep(restart, [answer("approve", "b")]);
    expect(finished.turn.suspended[0]?.approved?.map((request) => request.requestId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("projects the old coordination batch and grants without changing or deleting legacy records", () => {
    const legacy = {
      [LEGACY_GRANTS_KEY]: ["old-tool"],
      [LEGACY_BATCH_KEY]: {
        event: AT,
        tasks: [],
        responseMessages: stepResponse([approval("old")]),
        followingInput: { message: "following" },
      },
    };
    const unchanged = JSON.stringify(legacy);
    const migrated = legacyProjection(view(), legacy);
    const projected = projectHumanInput(
      { ...view(), turn: migrated.turn },
      migrated.turn.suspended[0],
    );
    expect(migrated.turn.grants).toEqual(["old-tool"]);
    expect(projected.held?.following).toEqual({ message: "following" });
    expect(projected.held?.messages).toEqual(stepResponse([approval("old")]));
    expect(JSON.stringify(legacy)).toBe(unchanged);
  });

  it("reconstructs budget, relay route and authorization metadata from the machine view", () => {
    const v = view();
    const req = approval("relay");
    const projection = foldSession(
      v.projection,
      createInputRequestedEvent({ ...AT, requests: [req] }),
    );
    const projected = projectHumanInput({
      ...v,
      projection,
      signIns: [challenge("attempt")],
      turn: {
        ...v.turn,
        limitRequest: { at: AT, request: BUDGET_QUESTION },
        relayedRoutes: { relay: route },
        relayedAuthorizations: { child: { at: AT, name: "github", runId: "run" } },
      },
    });
    expect(projected.requests.relay).toMatchObject({ kind: "relayed", route });
    expect(projected.requests[BUDGET_QUESTION.requestId]?.kind).toBe("session-limit");
    expect(
      Object.values(projected.requests).some((request) => request.kind === "authorization"),
    ).toBe(true);
    expect(projected.relayedAuthorizations?.child?.runId).toBe("run");
  });

  it("keeps arrivals behind the result-reading barrier", () => {
    const v = { ...view(), turn: { ...view().turn, readsResults: true as const } };
    const result = beforeStep(v, [message("later")]);
    expect(result.commands).toEqual([]);
    expect(result.turn.queued).toEqual({ message: "later", messageAuth: ALICE });
    expect(result.turn.readsResults).toBe(true);
  });
  it("preserves candidate settlements after commit/restart without asking the policy again", async () => {
    const base = view();
    const open = afterStep(
      base,
      approvalsRequested([approval("a")], { responsePolicyRequestIds: ["a"] }),
    );
    const waiting = { ...base, turn: open.turn };
    const response = answer("approve", "a");
    const projected = projectHumanInput(waiting, waiting.turn.suspended[0]);
    const checks: string[] = [];
    reduce(projected, response, "pre-step", (check) => {
      checks.push(check.candidateId);
      return undefined;
    });
    expect(checks).toHaveLength(1);
    const allowed = beforeStep(waiting, [
      {
        ...response,
        verdicts: { [checks[0]!]: { kind: "returned", value: { status: "allowed" } } },
      },
    ]);
    const saved = await applyTransition(
      session(),
      adaptHumanInput(waiting, allowed).transition,
      async () => {},
    );
    const restart = sessionView(
      initialSessionProjection(),
      JSON.parse(JSON.stringify(saved.state)),
    );
    expect(restart.turn.audit?.settlements.a?.approver).toEqual(ALICE);
    expect(restart.turn.audit?.activeCandidates).toEqual({});
    expect(restart.turn.suspended[0]?.approved?.map((request) => request.requestId)).toEqual(["a"]);
    expect(beforeStep(restart, [response]).commands).toEqual([]);
  });

  it("settles an originating step without touching a sibling with reused call ids", () => {
    const a = approval("a");
    const b = { ...approval("b"), action: { ...approval("b").action, callId: a.action.callId } };
    let v = view();
    for (const [stepIndex, request] of [
      [0, a],
      [1, b],
    ] as const) {
      const opened = afterStep(v, approvalsRequested([request], { at: { ...AT, stepIndex } }));
      v = { ...v, turn: opened.turn };
    }
    const approved = beforeStep(v, [answers({ a: "approve", b: "approve" })]);
    v = { ...v, turn: approved.turn };
    const result: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: a.action.callId,
          toolName: "a",
          output: { type: "text", value: "done" },
        },
      ],
    };
    const settled = afterStep(v, {
      at: AT,
      type: "actions.settled",
      results: [result],
      approved: {},
    });
    expect(settled.turn.suspended).toHaveLength(1);
    expect(settled.turn.suspended[0]?.event.stepIndex).toBe(1);
    expect(settled.turn.suspended[0]?.approved?.[0]?.requestId).toBe("b");
  });

  it("keeps the result barrier through effect completions and clears it on a whole model response", () => {
    const v = { ...view(), turn: { ...view().turn, readsResults: true as const } };
    const effectsCompleted = afterStep(v, { type: "actions.settled", at: AT, results: [] });
    expect(effectsCompleted.turn.readsResults).toBe(true);
    const modelCompleted = afterStep(v, { at: AT, inputs: [] });
    expect(modelCompleted.turn.readsResults).toBeUndefined();
    const cancelled = adapt([examples.cancelTurn], v);
    expect(cancelled.transition.turn.readsResults).toBeUndefined();
  });

  it("holds and stops a budget question with one resolution while preserving unrelated state", async () => {
    const v = view();
    const asked = beforeStep(v, [{ type: "budget.exceeded", at: AT, request: BUDGET_QUESTION }]);
    const first = adaptHumanInput(v, asked);
    const saved = await applyTransition(
      { ...session(), state: { unrelated: 1 } },
      first.transition,
      async () => {},
    );
    let projection = first.transition.events.reduce(foldSession, v.projection);
    const restarted = sessionView(projection, saved.state);
    expect(projectHumanInput(restarted).requests[BUDGET_QUESTION.requestId]?.kind).toBe(
      "session-limit",
    );
    expect(first.transition.events.some((event) => event.type === "turn.completed")).toBe(false);
    const stopped = adaptHumanInput(
      restarted,
      beforeStep(restarted, [answer("stop", BUDGET_QUESTION.requestId)]),
    );
    expect(
      stopped.transition.events.filter((event) => event.type === "input.resolved"),
    ).toHaveLength(1);
    projection = stopped.transition.events.reduce(foldSession, projection);
    const applied = await applyTransition(saved, stopped.transition, async () => {});
    expect(applied.state?.unrelated).toBe(1);
    expect(projectHumanInput(sessionView(projection, applied.state)).requests).toEqual({});
  });

  it("cancels multiple held lenses without duplicating sibling resolutions or terminal events", () => {
    let v = view();
    for (const [stepIndex, name] of [
      [0, "a"],
      [1, "b"],
    ] as const) {
      const opened = afterStep(
        v,
        approvalsRequested([approval(name)], { at: { ...AT, stepIndex } }),
      );
      v = {
        ...v,
        turn: opened.turn,
        projection: adaptHumanInput(v, opened).transition.events.reduce(foldSession, v.projection),
      };
    }
    const cancelled = adaptHumanInput(v, beforeStep(v, [{ type: "cancel.requested" }]));
    const resolutions = cancelled.transition.events.flatMap((event) =>
      event.type === "input.resolved" ? event.data.resolutions.map((item) => item.requestId) : [],
    );
    expect(resolutions).toEqual(["a", "b"]);
    expect(
      cancelled.transition.events.filter((event) => event.type === "turn.cancelled"),
    ).toHaveLength(1);
    expect(cancelled.transition.turn.suspended).toEqual([]);
    expect(cancelled.transition.commit?.filter((message) => message.role === "tool")).toHaveLength(
      2,
    );
  });
  it("queues attributed answers as well as messages behind results", () => {
    const v = { ...view(), turn: { ...view().turn, readsResults: true as const } };
    const result = beforeStep(v, [answer("approve", "a"), message("later")]);
    expect(result.commands).toEqual([]);
    expect(result.turn.queued?.attributedInputResponses).toEqual([
      { auth: ALICE, response: { optionId: "approve", requestId: "a" } },
    ]);
  });

  it("folds relay lifecycle between arrivals before handing an answer to the outbox", () => {
    const v = view();
    const next = beforeStep(v, [
      { type: "relayed.requested", at: AT, requests: [approval("child")], route },
      { type: "delivery.received", responses: [{ requestId: "child", optionId: "approve" }] },
    ]);
    const result = adaptHumanInput(v, next);
    expect(result.effects).toEqual([
      { type: "forwardAnswer", route, responses: [{ requestId: "child", optionId: "approve" }] },
    ]);
    expect(result.transition.events.map((event) => event.type)).toEqual([
      "input.requested",
      "turn.waiting",
      "input.resolved",
    ]);
    expect(result.transition.turn.relayedRoutes).toEqual({});
  });

  it("migrates the old HumanInput key into machine fields rather than storing another projection", async () => {
    const request = approval("old");
    const legacy = {
      [STATE_KEY]: {
        grants: ["old-grant"],
        requests: {
          old: { kind: "tool-approval", at: AT, request, requester: ALICE, approvalKey: "old-key" },
        },
        held: { at: AT, messages: stepResponse([request]) },
      },
    };
    const migration = legacyProjection(view(), legacy);
    const saved = await applyTransition(session(), { ...migration, events: [] }, async () => {});
    expect(saved.state?.[STATE_KEY]).toBeUndefined();
    const restarted = sessionView(initialSessionProjection(), saved.state);
    expect(projectHumanInput(restarted, restarted.turn.suspended[0]).requests.old).toMatchObject({
      approvalKey: "old-key",
      requester: ALICE,
    });
    expect(restarted.turn.grants).toEqual(["old-grant"]);
  });
  it("projects saved-step cancel closures without re-publishing them on rollback cleanup", () => {
    const v = view();
    const held = afterStep(v, approvalsRequested([approval("a")]));
    const saved = { ...v, turn: held.turn };
    const carried = beforeStep(saved, [{ type: "cancel.replayed" }]);
    expect(carried.commands.some((command) => command.type === "publish")).toBe(false);
    expect(carried.turn.suspended[0]?.requests).toEqual([]);
    expect(carried.turn.suspended[0]?.messages).toEqual(stepResponse([approval("a")]));
    const cleanup = beforeStep({ ...saved, turn: carried.turn }, [{ type: "cancel.requested" }]);
    expect(
      cleanup.commands.filter(
        (command) => command.type === "publish" && command.event.type === "input.resolved",
      ),
    ).toEqual([]);
    expect(cleanup.turn.suspended).toEqual([]);
  });
});
