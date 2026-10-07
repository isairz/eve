---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-07"
---

# Session machine simplification

Read on `main` at `285d4e09b` and the open HumanInput stack (#4342–#4344). Line counts are production code, without tests. The savings are estimates from reading code; nothing was prototyped.

## Summary

The core of a session is simple. A session is a loop of turns. A turn is a sequence of model calls and the calls they make, and some of those calls wait for a person or for another run. The code that runs it is about 30,000 lines, because that core is implemented several times over:

- each kind of wait has its own record, step result, waiter, and resume path;
- each kind of work implements each lifecycle operation separately;
- five state channels are kept in sync by hand;
- 63 durable steps each repeat the same ceremony;
- eve intercepts the AI SDK's inner loop instead of owning it.

This doc proposes cuts that remove about 7,000–10,000 of those lines, a quarter to a third. They overlap, so the savings don't simply add up.

Two of the cuts help [`session-event-lifecycle.md`](./session-event-lifecycle.md) land:

- **Lifecycle only in the projection** is required before interactions move to the new events.
- **One commit path** is recommended before the event break.

The rest are independent, and can land before or after it.

## Where the lines go

| Area                                                                                     | Where                                                                                      | Lines |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----- |
| Session workflow program: the session loop, the turn loop, the turn step, waits, handoff | `execution/session/`                                                                       | 4,600 |
| Session machine                                                                          | `harness/session-machine/`                                                                 | 1,200 |
| Step pipeline, tool loop, SDK interception, emission                                     | `harness/` top level, `harness/step/`                                                      | 9,000 |
| Human input: approvals, sign-ins, questions, relays, budget                              | `harness/hitl/`; about 6,800 after HumanInput                                              | 3,350 |
| Delegated work: tasks, workflow tools, agent sessions, subagents                         | `execution/tasks/`, `execution/tools/workflow/`, `execution/agent-sessions/`, `subagents/` | 7,900 |
| Inbox and other execution glue                                                           | `execution/session-inbox/`, `execution/` top level                                         | 5,600 |
| Legacy compatibility                                                                     | `execution/legacy-session/`, `execution/legacy-remote-agent/`                              | 810   |

Outside that total are model-call plumbing (2,300), compaction (1,100), sandboxes (9,000), and other tool implementations.

## Why it's large

### Every wait is a suspension, in about seven shapes

A durable step can't stay open while a person or a run works. So each kind of wait needs all of these:

- **A private record:** the turn's suspended steps, a runtime wait's call IDs, `pendingAuthorization`, `proxyInputRequests`, the workflow tool run registry, the task table.
- **A step-result variant.** `DurableStepResult` has `continue` or `done`, `cancelled`, `steered`, `held` on tasks, `held` on a request, and `park` with pending calls.
- **A workflow-side waiter:** `waitForHeldRequest`, `waitForHeldTurn`, `waitForRuntimeActionResults`, `nextParkedActivity`.
- **A resume stage** at the start of the next step, such as settling runtime work or accepting human input.
- **Facts** in the projection.

### Kinds of work times lifecycle operations

**Kinds of work:**

- inline tools that the SDK runs;
- approved inline calls that eve runs itself;
- provider tools and MCP tools;
- workflow `execute`, `task()`, and `serve()`;
- local and remote agent sessions;
- nested connection calls.

**Lifecycle operations:** start, progress, ask, sign in, approve, return, cancel or interrupt, and crash.

Each pair is implemented per kind:

- **Two executors for inline calls.** The SDK runs most of them through the wrappers in `harness/tools.ts` and the stash in `tool-interrupts.ts`. `harness/hitl/approved-calls.ts` (340 lines) reimplements validation, `Promise.allSettled`, partial outputs, and `toModelOutput` for approved ones.
- **25 cancel functions in 17 files.**
- **Two registries for running work:** blocking workflow tool runs (`harness/workflow-tool-runs.ts`) and the task table (`execution/tasks/table.ts`). Both store a run ID and a hook token.
- **At least five internal protocols for the same handful of messages:**
  - workflow tool run messages (17 kinds);
  - the session inbox;
  - hook payloads for subagent requests and runtime results;
  - remote HTTP callbacks, plus remote agent protocol 1;
  - parent notifications.

### Five state channels, synced by hand

1. **Model history.** The AI SDK's pairing rules force repair helpers wherever calls are interrupted.
2. **Private records,** about ten of them.
3. **The serialized context container.**
4. **The projection.**
5. **The stream.**

On top of those come adapter state, instrumentation, and workflow attributes.

**Example:** turn identity is derived independently four times, always as `` `turn_${n}` ``:

- in `protocol/session-projection.ts`;
- in `harness/session-machine/view.ts`;
- in `execution/workflow-trace-context.ts`;
- in `execution/session/program.ts`, which keeps its own counter. That counter restarts in every owner run, so after a handoff a failure is attributed to the wrong turn.

### 63 durable steps, each with its own ceremony

There are 66 step functions in 37 files, 3 of them legacy. Each repeats restore, publish, and save; there are 54 sites of `cursor.advance`, `withSessionStateDelta`, and `restoreSessionStep`.

Eleven small steps exist mostly to publish a few events from workflow code, among them:

- turn waiting;
- settling a cancelled turn;
- terminal completion and failure;
- withdrawing a request;
- coordination dispatch;
- task steps;
- workflow tool reports;
- proxied deliveries.

### The AI SDK owns the inner loop, so eve intercepts it

eve:

- wraps every tool;
- stashes interrupts out of band, because the SDK records tool outputs into telemetry;
- extracts approvals from response parts;
- mirrors the SDK's stream into events;
- repairs history after interrupts.

This cluster overlaps the areas above.

## The cuts

| Cut                                                                                       | Saves       | For the event lifecycle                                      |
| ----------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------ |
| [Turn identity from the projection](#turn-identity-from-the-projection)                   | A bug fix   | Lands first; retry recovery relies on deterministic turn IDs |
| [One commit path](#one-commit-path)                                                       | 800–1,200   | Recommended before the break                                 |
| [Lifecycle only in the projection](#lifecycle-only-in-the-projection)                     | 500–1,000   | Required before interactions move                            |
| [One suspension record](#one-suspension-record)                                           | 1,000–1,500 | Optional; makes `turn.paused.awaiting` a direct read         |
| [One registry and protocol for running work](#one-registry-and-protocol-for-running-work) | 1,500–2,500 | Optional; the relay half lands with the event break          |
| [One executor for every call](#one-executor-for-every-call)                               | 1,500–2,500 | Optional; makes call outcomes exact                          |
| [Delete compatibility at the break](#delete-compatibility-at-the-break)                   | About 1,500 | At the break                                                 |

### Turn identity from the projection

**Problem.** `execution/session/program.ts` keeps `turnIndex` locally and sets `progress.turnId = `turn_${turnIndex++}``. The counter restarts in each owner run. The failure path passes that ID to `finalizeSession`, while the completion path uses `lastPublishedTurn`, so after a handoff a failing session names the wrong turn.

**Cut.** Read the turn from the projection everywhere (`turnPosition`, `activeTurnId`), and delete the local counter and `lastPublishedTurn`.

**Notes.** It's small, and can land now. `program.ts` is in HumanInput's diff, so it's worth coordinating with that stack's authors on whether to land it before or after.

### One commit path

**Problem.** The eleven small publishing steps each restore the session, publish one or two events through their own path, and save a delta. `harness/session-machine/commit.ts` applies a transition by publishing its events one at a time, so a "commit" has no boundary that the stream can see.

**Cut.** Every step that changes the session applies its inputs through one machine commit: restore, transition, publish the commit, save. HumanInput already has the seed of this: `commitSessionStep(target, inputs)` in `execution/session/human-input-step.ts`, used by the task steps and the workflow tool withdraw step. That becomes the session's commit path, not a HumanInput helper, and keeps today's effect order.

**For the event lifecycle.** "One transition, one commit, one stream line" becomes true everywhere at once, instead of only in the turn step.

### Lifecycle only in the projection

**Problem.** Some lifecycle status lives in two places: in the projection, and in private records such as human input's request and batch state. Two authorities can disagree, and readers outside `hitl/` are tempted to read the private one. HumanInput also builds turn and message events itself (`turn.waiting` and `message.completed`, among its 26 v26 event builder calls).

**Cut.**

- The projection is the only lifecycle authority.
- Private records hold payloads, routes, grants, and resume data, never status.
- `hitl/` emits only interaction, candidate, and call-rejection facts. The machine owns turn and delivery facts.

**For the event lifecycle.** Required before interactions move to the new events. Otherwise two producers write turn facts.

### One suspension record

**Problem.** The seven wait shapes above.

**Cut.**

- `turn.paused {awaiting}` becomes the only record of what a turn waits on.
- One waiter wakes on any input that references an awaited entity.
- One intake applies inputs as transitions.
- A step returns one of four results: continue, paused, settled, or cancelled.

**For the event lifecycle.** Optional. It makes `turn.paused.awaiting` a direct read instead of a translation.

### One registry and protocol for running work

**Problem.** Two registries, about 25 cancel functions, and at least five protocols for the same messages.

**Cut:**

- **One registry:** workflow tools, tasks, and local and remote agents register in one table of running work, keyed by `callId`, with one cancel path.
- **One protocol:** they speak the same owner messages. Relays become one request-and-answer routing table.

**Notes.**

- HumanInput already folds the human-input relay paths into `harness/hitl/relay.ts`, deleting `subagents/hitl-proxy.ts` and `harness/proxy-input-requests.ts`. What remains is the registry and the other messages.
- The relay contract between parent and child sessions, keyed by child IDs, parsed tolerantly, and under a new remote protocol version, lands with the event break, because it replaces v26 event payloads ([Child sessions and relays](./session-event-lifecycle.md#child-sessions-and-relays)).

### One executor for every call

**Problem.** The SDK runs most inline calls while eve runs approved ones, and eve intercepts the SDK to stash interrupts, extract approvals, and repair history.

**Cut.** The SDK only calls the model: tools are given to it without `execute`, and eve runs every call. Approval, sign-in, steering aborts, and approved execution become one path. That removes:

- the interception layer;
- the duplicate executor;
- most history repair.

**For the event lifecycle.** Optional. It makes "calls settle by what actually happened" exact rather than best-effort. It's also the natural place for a private journal of run and tool results, so a retried step can reuse them.

**Risks.** It changes how eve uses the AI SDK's multi-step loop, provider-executed tools, streaming tool input, and `toModelOutput`. Prototype it first.

### Delete compatibility at the break

Sessions don't cross the event break, so the break can delete:

- the one-time legacy session import (`execution/legacy-session/`, 638 lines). That's a product decision;
- remote agent protocol 1 (`execution/legacy-remote-agent/`, 172 lines);
- most checkpoint migrations (`execution/session/checkpoint-migrations.ts`, 330 lines), once `MIN_SESSION_CHECKPOINT_VERSION` moves to the break;
- HumanInput's legacy parking keys (`harness/hitl/state-legacy.ts`).

The first two are also counted in [`session-event-lifecycle.md`](./session-event-lifecycle.md#size).

## Sequencing

1. **Now:** turn identity from the projection.
2. **HumanInput (#4342–#4344)** lands. It's rebased onto the session-state stack and in review. What these cuts need from it:
   - `commitSessionStep` becomes the session's commit path;
   - no new readers of its private request state outside `hitl/`;
   - an output for "answer admitted", which the event lifecycle publishes as `interaction.responded`.
3. **After HumanInput,** in any order:
   - one commit path;
   - lifecycle only in the projection, before interactions move;
   - one suspension record;
   - one registry;
   - the executor prototype.
4. **At the break:** the compatibility deletions.

## What stays

These parts are mostly essential, and unlikely to shrink much:

- **model-call plumbing:** provider errors and recovery;
- **durability and handoff:** sessions move between deployments by checkpoint, so the program counter has to be data, not a JavaScript stack;
- **human-input policy rules:** response policies, candidates, budgets;
- **compaction;**
- **task semantics.**

## Open questions

1. **When should the executor prototype happen?** Before the event break, it would make call outcomes exact from v27.0. After it, it isn't on the critical path.
2. **Does any product still need the legacy session import?**
