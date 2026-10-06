---
issue: https://linear.app/vercel/issue/AX-5133
status: implementing
last_updated: "2026-10-06"
---

# Declarative tool stubs

Evals need predictable tool results against local and deployed agents, while checking both requested actions and user-facing responses. Provide JSON constants and sequences at session creation; keep existing tool, order, and response assertions separate.

```ts
const session = await t.session({
  stubs: [
    { id: "tasks", tool: "list_tasks", responses: [["milk", "dog"], ["dog"]] },
    {
      id: "complete",
      tool: "complete_task",
      match: { task_id: { const: "milk" } },
      response: { success: true },
    },
  ],
});
await session.send("List my tasks.");
const completed = await session.send("Complete milk, then list what remains.");
completed.calledTool("complete_task", { input: { task_id: "milk" }, count: 1 });
completed.toolOrder(["complete_task", "list_tasks"]);
```

## Contract

- Fixed configuration for a root session and its local descendants. Root names are unqualified; subagent tools use slash-separated delegation paths such as `researcher/list_tasks`. No implicit cross-agent matching. Repeated subagents at the same path share playback; new roots are isolated and remote agents never receive the configuration.
- A named input field must exist and satisfy its reference-free JSON Schema constraint. Extra top-level fields are allowed. Reject malformed or unsupported constraints at request admission; compile matchers when playback initializes and reuse them for tool calls. A compilation error fails the session before tools execute. Matching does not coerce or mutate input.
- Read rules top to bottom; the first match wins. Put specific rules before catch-alls. No match runs the real tool. A selected stub failure never invokes the real executor and fails the eval even if the model recovers.
- Each rule advances per logical matching call, including several calls within a turn. Replays and retries reuse the recorded result; exhaustion repeats the last response. Unused stubs are allowed.
- Ordinary, dynamic, workflow, and qualified connection operations retain validation, approval, output processing, and event envelopes. Persistent tools require unconditional replacement. Provider-hosted tools are outside scope.
- Connection discovery and authentication stay live; stubs replace only execution of a known operation.

## Durable playback

The original root workflow owns a serial request hook, per-rule positions, and a map of logical call identities to responses. Ordinary executors and workflow bodies request a decision at their existing execution boundary. Durable result streams deliver the decision; root replay reconstructs positions and deduplicates calls. The original root remains the playback owner across session handoffs. Checkpoint version 13 prevents older deployments from accepting a stubbed session and silently executing live tools. Local descendants use its opaque hook token and root id, adding their delegation path for exact tool matching. State holds playback records, never a simulated external database or user code.

The first stub failure is recorded before its response is released. The eval runner reads the session's authenticated stub status before grading completion. Output conversion failures use one recording contract across ordinary execution, workflow execution, and task/serve projection. Queued task results retain their originating calls so delayed projection can identify the correct stub. Playback service failures interrupt the current session owner through its stable inbox, including after a handoff. Parallel calls are admitted serially, without imposing a global expected call script.

## Authorization

Reuse existing route authentication. `vercelOidc({ subjects: [{ subject: vercelSubject({ teamSlug: "acme", projectName: "eval-runner" }), allowToolStubs: true }] })` attaches replacement permission to an explicitly matched subject. Strings still authenticate without granting replacement. Any explicitly granting entry wins; implicit current-project acceptance never grants. Project rules apply only to service/runtime identities, not projected users. Custom authenticators can return the same `AuthResult.allowToolStubs` after verification. Strip route permissions before persisting or forwarding identity; no separate channel policy is needed.

Check replacement permission at creation against the verified route caller before `onMessage` projection. Later messages, approvals, controls, and result reads use normal channel auth, without additional stub-specific ownership checks or permission rechecks. Session isolation is application policy, as for ordinary sessions; callers admitted to a session can use its configured stubs. Playback hooks have unguessable tokens; caller-supplied context cannot manufacture a trusted scope.

## Verification

Keep the shared JSON Schema dependency unpatched. Its [known conformance defects](https://github.com/cfworker/cfworker/issues/338) and [negative decimal bug](https://github.com/cfworker/cfworker/issues/337) are documented in the tool-stub guide and retained as expected-failure regressions. A wrong match can select the wrong response or fall through to the real tool, so affected constraints are a documented limitation, not a conformance guarantee.

Behavior tests cover matching, first-match precedence, sequence exhaustion, concurrent admission, replay, handoff, descendants, whole-agent replacement, approvals, selected failures, and authorization. An HTTP fixture eval exercises ten concurrent calls, another turn, and an independent session across CI workflow worlds. Measure the extra workflow dispatch/stream latency in those worlds before claiming production performance.

Full stateful mocks, arbitrary functions, callback connections, per-turn reconfiguration, and mixing live and mocked calls within a persistent tool are excluded.

Keep required rule IDs. Exposing them and their response positions in existing execution traces is a follow-up ([AX-5157](https://linear.app/vercel/issue/AX-5157)); optional tool-specific response types are [AX-5161](https://linear.app/vercel/issue/AX-5161), and the shared JSON Schema validator assessment is [AX-5162](https://linear.app/vercel/issue/AX-5162).
