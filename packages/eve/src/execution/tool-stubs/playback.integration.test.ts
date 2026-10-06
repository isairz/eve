import { jsonSchema } from "ai";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey, ToolStubsKey } from "#context/keys.js";
import { toolStubProvider } from "#context/providers/tool-stubs.js";
import { appendTaskContext } from "#execution/tasks/model-step.js";
import {
  createTask,
  readTaskTable,
  settleTaskCalls,
  writeTaskTable,
} from "#execution/tasks/table.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { describe, expect, it } from "vitest";
import { start } from "#internal/workflow/runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { workflowEntry } from "#execution/session/entry.js";
import { callToolStubStep, readStubFailure } from "#execution/tool-stubs/steps.js";
import { STUB_CONTEXT_KEY } from "#tool-stubs/types.js";

describe("durable tool stub playback", () => {
  it("allocates concurrent calls once and reuses an earlier result after later workflow resumes", async () => {
    const runtime = await createTestRuntime({ agent: { name: "stub-playback" } });
    await runtime.run(async () => {
      const rules = [
        { id: "list", tool: "list_tasks", responses: [["milk", "dog"], ["dog"]] },
      ] as const;
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: {},
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            [STUB_CONTEXT_KEY]: { token: "test-stub-playback", rules },
          },
        },
      ]);
      await waitForHook({ runId: run.runId }, { token: "test-stub-playback" });
      const scope = {
        token: "test-stub-playback",
        rootSessionId: run.runId,
        rules,
      };
      const call = { tool: "list_tasks", input: {} };
      const outputs = await Promise.all([
        callToolStubStep(scope, { ...call, callId: "root:first" }),
        callToolStubStep(scope, { ...call, callId: "child:second" }),
      ]);
      expect(
        outputs.map((result) => (result.kind === "stub" ? result.position : null)).sort(),
      ).toEqual([0, 1]);
      expect(await callToolStubStep(scope, { ...call, callId: "root:first" })).toEqual(outputs[0]);
      expect(await callToolStubStep(scope, { ...call, callId: "root:third" })).toEqual({
        kind: "stub",
        ruleId: "list",
        position: 1,
        response: ["dog"],
      });
      expect(await readStubFailure(run.runId)).toBeUndefined();
    });
  });
  it.each([true, false])(
    "attributes delayed task projection to its original call (stubbed: %s)",
    async (stubbed) => {
      const runtime = await createTestRuntime();
      await runtime.run(async () => {
        const rules = [
          { id: "task", tool: "lookup", match: { value: { const: "stubbed" } }, response: "raw" },
        ];
        const token = "delayed-task-projection";
        const run = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: {},
            serializedContext: {
              ...buildSerializedContext({ channelKind: "http" }),
              [STUB_CONTEXT_KEY]: { token, rules },
            },
          },
        ]);
        try {
          await waitForHook({ runId: run.runId }, { token });
          const scope = { token, rules, rootSessionId: run.runId };
          await callToolStubStep(scope, {
            callId: `${run.runId}:turn_0:lookup`,
            tool: "lookup",
            input: { value: stubbed ? "stubbed" : "live" },
          });
          const task = createTask(readTaskTable(undefined), {
            callId: "lookup",
            kind: "tool",
            name: "lookup",
            resumable: false,
            turnId: "turn_0",
          });
          const { table } = settleTaskCalls(task.table, {
            taskId: task.taskId,
            callIds: ["lookup"],
            outcome: { status: "completed", output: "raw" },
          });
          // Persisted task state crosses the turn boundary before the adapter sees it.
          const session = JSON.parse(
            JSON.stringify(
              writeTaskTable(
                createTestSessionState({ sessionId: run.runId }).snapshot.session,
                table,
              ),
            ),
          );
          const context = new ContextContainer();
          context.set(SessionKey, {
            sessionId: run.runId,
            turn: { id: "turn_1", sequence: 1 },
            auth: { current: null, initiator: null },
          });
          await contextStorage.run(context, async () => {
            context.set(ToolStubsKey, scope);
            context.setVirtualContext(
              toolStubProvider.key,
              toolStubProvider.create(context)!.value,
            );
            const delivered = await appendTaskContext({
              session,
              messages: [],
              projectHistory: (messages) => messages,
              tools: new Map([
                [
                  "lookup",
                  {
                    name: "lookup",
                    description: "Lookup",
                    inputSchema: jsonSchema({ type: "object" }),
                    toModelOutput: () => {
                      throw new Error("Invalid output.");
                    },
                  },
                ],
              ]),
            });
            expect(JSON.stringify(delivered.messages)).toContain("raw");
            expect(readTaskTable(delivered.session.state).tasks[0]?.results).toEqual([]);
          });
          expect(await readStubFailure(run.runId)).toBe(
            stubbed ? 'Stubbed tool "lookup" failed during output processing.' : undefined,
          );
        } finally {
          await run.cancel();
        }
      });
    },
  );
});
