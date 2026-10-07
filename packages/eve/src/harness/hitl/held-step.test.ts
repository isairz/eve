import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  AT,
  Turn,
  answer,
  approval,
  approvalsRequested,
  cancel,
  challenge,
  message,
  authorizationRequired,
} from "#internal/testing/hitl.js";

// One model step can make calls that wait on a person (approvals, authorizations)
// and calls that run as runtime work (`build`, a workflow tool). The step is
// held out of history, in one place, until every call it made has a result.

const buildTask = {
  callId: "call-build",
  entry: { entryPoint: "execute" as const },
  input: {},
  kind: "workflow-task" as const,
  toolName: "build",
  workflowId: "workflow//./agent/tools/build//execute",
};

function call(toolCallId: string, toolName: string) {
  return { input: {}, toolCallId, toolName, type: "tool-call" as const };
}

function result(toolCallId: string, toolName: string, value: string) {
  return {
    output: { type: "text" as const, value },
    toolCallId,
    toolName,
    type: "tool-result" as const,
  };
}

const built: ModelMessage = { content: [result("call-build", "build", "built")], role: "tool" };

/** The step's response: its calls, with a result for the authorization call that asked. */
function response(...calls: ReturnType<typeof call>[]): ModelMessage[] {
  const asked = calls.filter((c) => c.toolName === "weather");
  return [
    { content: calls, role: "assistant" },
    ...(asked.length === 0
      ? []
      : [
          {
            content: asked.map((c) => result(c.toolCallId, c.toolName, "Authorize first.")),
            role: "tool" as const,
          },
        ]),
  ];
}

const mixes = {
  "an approval": [call("call-deploy", "deploy"), call("call-build", "build")],
  "an authorization": [call("call-weather", "weather"), call("call-build", "build")],
  "an authorization and an approval": [
    call("call-weather", "weather"),
    call("call-deploy", "deploy"),
    call("call-build", "build"),
  ],
} as const;

/** The post-step order the tool loop commits in: approvals, runtime calls, then authorizations. */
function heldCalls(calls: readonly ReturnType<typeof call>[]): Turn {
  const messages = response(...calls);
  let turn = Turn.idle();
  if (calls.some((c) => c.toolName === "deploy")) {
    turn = turn.input(approvalsRequested([approval("deploy")], { messages }));
  }
  turn = turn.input({ at: AT, messages, tasks: [buildTask], type: "actions.dispatched" });
  if (calls.some((c) => c.toolName === "weather")) {
    turn = turn.input(authorizationRequired([challenge("a1")], ["call-weather"], messages));
  }
  return turn.stored();
}

function unpaired(messages: readonly ModelMessage[]): string[] {
  const called = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const part of m.content) {
      if (part.type === "tool-call") called.add(part.toolCallId);
      if (part.type === "tool-result") answered.add(part.toolCallId);
    }
  }
  return [
    ...[...called].filter((id) => !answered.has(id)).map((id) => `call without result: ${id}`),
    ...[...answered].filter((id) => !called.has(id)).map((id) => `result without call: ${id}`),
  ];
}

describe("a model step held on runtime calls and a person", () => {
  describe.each(Object.keys(mixes) as (keyof typeof mixes)[])("with %s", (mix) => {
    const calls = mixes[mix];
    const asksApproval = calls.some((c) => c.toolName === "deploy");

    it("holds the step, with each waiting call tagged by what it waits on", () => {
      const held = heldCalls(calls);

      expect(held.appended()).toEqual([]);
      expect(held.humanInput.heldCalls()?.calls).toEqual([
        { callId: "call-build", toolName: "build", waitsOn: "runtime" },
        ...(asksApproval ? [{ callId: "call-deploy", toolName: "deploy", waitsOn: "person" }] : []),
      ]);
      // The call that asked for an authorization left the step: the model calls it again.
      expect(JSON.stringify(held.humanInput.heldMessages())).not.toContain("call-weather");
      expect(held.humanInput.runtimeCalls()?.tasks).toEqual([buildTask]);
    });

    it("resumes: the runtime result joins the step, which joins history once the person answers", () => {
      const ran = heldCalls(calls)
        .input({ results: [built], type: "actions.settled" })
        .stored();
      expect(ran.humanInput.runtimeCalls()).toBeUndefined();

      if (!asksApproval) {
        // Nothing else waits in the step: it joins history whole, and the turn waits on the authorization.
        expect(unpaired(ran.appended())).toEqual([]);
        expect(ran.humanInput.holdsStep()).toBe(false);
        expect(ran.next()).toEqual({ waiting: "input" });
        return;
      }
      expect(ran.appended()).toEqual([]);
      const answered = ran.input(answer("approve", "deploy")).stored();
      expect(answered.approvedCalls()?.requests).toHaveLength(1);
      const settled = answered.ranApproved([
        { content: [result("call-deploy", "deploy", "deployed")], role: "tool" },
      ]);
      const history = settled.appended();
      expect(unpaired(history)).toEqual([]);
      expect(JSON.stringify(history)).toContain("built");
      expect(JSON.stringify(history)).toContain("deployed");
    });

    it("steers: Alice's message past the person, after the runtime result, answers every call", () => {
      const ran = heldCalls(calls).input({ results: [built], type: "actions.settled" });
      const steered = ran.stored().input(message("Skip the rest."));
      const history = [...ran.appended(), ...steered.appended()];

      expect(steered.stored().humanInput.holdsStep()).toBe(false);
      expect(steered.stored().next()).not.toEqual({ waiting: "input" });
      expect(unpaired(history)).toEqual([]);
      expect(JSON.stringify(history)).toContain("built");
    });

    it("cancels: one input answers every unsettled call as not run, in one tool message", () => {
      const cancelled = heldCalls(calls).input(cancel);
      const history = cancelled.appended();

      expect(unpaired(history)).toEqual([]);
      expect(history.filter((m) => m.role === "tool")).toHaveLength(1);
      const results = history.flatMap((m) =>
        m.role === "tool" ? m.content.filter((part) => part.type === "tool-result") : [],
      );
      expect(results.map((part) => [part.toolCallId, part.output.type])).toEqual([
        ["call-build", "text"],
        ...(asksApproval ? [["call-deploy", "execution-denied"]] : []),
      ]);
      expect(cancelled.stored().storesNothing()).toBe(true);
    });
  });

  it("reads the turn's input that waited behind approved runtime calls once their results join", () => {
    const approved = Turn.idle()
      .input(approvalsRequested([approval("deploy")]))
      .input(answer("approve", "deploy"))
      .stored()
      .input({
        approved: { following: { message: "Then tell me." } },
        results: [],
        running: [{ ...buildTask, callId: "call-deploy", toolName: "deploy" }],
        type: "actions.settled",
      })
      .stored();

    const settled = approved.input({
      results: [{ content: [result("call-deploy", "deploy", "deployed")], role: "tool" }],
      type: "actions.settled",
    });

    // It waits for the turn's next step, which reads it after the results.
    expect(settled.reported("resumeInput")).toEqual([]);
    const taken = settled.stored().input({ type: "input.resumed" });
    expect(taken.reported("resumeInput")).toEqual([
      { input: { message: "Then tell me." }, type: "resumeInput" },
    ]);
    expect(settled.stored().humanInput.hasQueuedInput()).toBe(true);
    expect(taken.stored().humanInput.hasQueuedInput()).toBe(false);
    // A cancel drops it with the turn, before or after the calls join.
    expect(approved.input(cancel).reported("resumeInput")).toEqual([]);
    expect(settled.stored().input(cancel).stored().humanInput.hasQueuedInput()).toBe(false);
  });
});
