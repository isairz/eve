---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-07"
---

# Dynamic participant points

Read on `main` at `285d4e09b`. Nothing was prototyped.

## Summary

Dynamic resolvers (`defineDynamic({ events })`) and memory providers key their handlers on stream event names: `session.started`, `turn.started`, `step.started`, `compaction.requested`, `compaction.completed`, `turn.completed`. But they don't observe the stream. They take part in the machine's work, before or while it decides, and what they return changes what the model sees. To drive them, the machine fakes events that are never published, and each participant filters those events its own way.

This doc proposes, before 1.0:

- **A small catalog of points** with base-form names (`session.start`, `turn.start`, `model.start`, `compaction.start`, `compaction.complete`, `turn.complete`), separate from the stream's facts.
- **Every existing key stays a compile-time alias,** with unchanged timing and semantics.
- **A typed first argument** describing the point, in place of today's `unknown`.
- **One pipeline that runs every participant,** replacing the synthetic events and the per-participant dispatch.

It isn't on the critical path for [`session-event-lifecycle.md`](./session-event-lifecycle.md), and either can land first. But that proposal removes `step.started`, `turn.completed`, and `compaction.*` from the stream. Without this change, participant keys would keep naming facts that no longer exist.

## Participants versus observers

|                  | Observers                                         | Participants                                                                    |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Who              | Hooks, channel handlers                           | Dynamic model, tools, instructions, skills, connections, subagents; memory      |
| Run on           | Facts written to the stream                       | Points in the machine's work                                                    |
| Can change state | No; they react to what was decided                | Yes; their results feed the model call, and are recorded so restores reuse them |
| Keyed by         | The stream catalog, which evolves with the stream | A closed catalog per major version                                              |

The naming rule for authors: **past tense (`turn.started`) is a fact on a stream you observe; base form (`turn.start`) is a phase you take part in.**

## Today

### Who runs where

| Key                    | Participants                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `session.started`      | Dynamic model, tools, instructions, skills, connections, subagents                      |
| `turn.started`         | The same, plus memory recall (required) and memory tools                                |
| `step.started`         | Dynamic model and tools; framework connection tools; skill and connection announcements |
| `compaction.requested` | Memory capture                                                                          |
| `compaction.completed` | Memory recall                                                                           |
| `turn.completed`       | Memory capture                                                                          |

The allowed keys are spread across `ALLOWED_DYNAMIC_*` sets in `dynamic/definition.ts` and `context/dynamic-{model,subagent}-lifecycle.ts`. Instructions, skills, connections, and subagents are limited to session and turn boundaries, so the model's input doesn't change between tool-loop steps.

### How they're dispatched

**Published events.** `execution/session/turn-event-handler.ts` runs for each event a turn publishes, in this order:

1. write the event (channel adapter, then the stream);
2. memory, through a type switch in `dispatchMemoryLifecycleEvent`;
3. hooks;
4. the dynamic model, skipped for `step.started`;
5. connections, subagents, tools, skills, and instructions.

Each dispatcher in steps 4–5 checks its own allowed set, and some add special cases:

- skills rebuild their announcement on `step.started` even though skill resolvers can't run there;
- connections announce themselves on `step.started`.

**Synthetic events.** Several paths need participants to run again without publishing anything. They build events from `harness/session-machine/resolver-events.ts`, whose comment says they "are never published":

| Path                      | Where                                                  | Fakes                                                      |
| ------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| Model selection           | `harness/model-call/run.ts` `selectModel`              | `step.started`, with `modelId: "dynamic"` as a placeholder |
| Redeploy refresh          | `execution/session/turn-step.ts`                       | `session.started`, for subagents and tools                 |
| Callback rebind           | `execution/session/turn-step.ts`                       | `turn.started`                                             |
| Approval turn preparation | `execution/session/turn-step.ts` `prepareApprovalTurn` | `turn.started`, for connections                            |
| Connection rehydrate      | `execution/dynamic-connections.ts`                     | `session.started`, then `turn.started`                     |
| Parked-step tool restore  | `harness/hitl/intake.ts`                               | `step.started`                                             |

Dynamic model selection has to run before the model call that the published `step.started` records, so the dispatcher skips the real event and `selectModel` fakes one ahead of time.

**Untyped payloads.** A handler's first argument is `unknown` (`DynamicEvents` in `dynamic/definition.ts`). The docs tell authors to read messages from `ctx` and say only that "the event itself contains turn metadata".

### What that costs

- **The names promise stream facts that aren't there.** A resolver's `step.started` fires before the model call that the published `step.started` describes. The synthetic events aren't on the stream, and they carry placeholder data.
- **Participant keys break whenever the stream vocabulary changes.** At v27 that would mean either an authored break for every dynamic resolver and memory provider, or keys that name facts that no longer exist.
- **Dispatch is scattered:**
  - six type-filtered dispatch calls;
  - allowed sets in several files;
  - special cases for `step.started`;
  - a type switch for memory;
  - each re-entry path choosing which event to fake.
- **Authors can't rely on the payload,** because it's typed `unknown`.

## Proposal

### The point catalog

Timing is unchanged from today. Every old key stays a compile-time alias with the same semantics.

| Point                 | Runs                                                   | Participants                                                       | Alias                  |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------- |
| `session.start`       | After the session's opening commit                     | Dynamic model, tools, instructions, skills, connections, subagents | `session.started`      |
| `turn.start`          | After the turn's opening commit                        | Memory recall and memory tools, then the dynamic ones              | `turn.started`         |
| `model.start`         | Before each responding model call                      | Dynamic model and tools                                            | `step.started`         |
| `compaction.start`    | Before the compaction run                              | Memory capture                                                     | `compaction.requested` |
| `compaction.complete` | After compaction replaces the context, on success only | Memory recall                                                      | `compaction.completed` |
| `turn.complete`       | After the turn settles `completed`, on success only    | Memory capture                                                     | `turn.completed`       |

- **`model.start`** runs before every model call a turn makes to respond, including after tool results, task results, approvals, steering, and a completed sign-in. It doesn't run for each provider retry inside one call. The stream's `model.started` fact then records the model that was chosen.
- **`*.complete` means the phase completed normally.** Failed or cancelled turns and compactions have no complete point, which matches today's memory semantics. Capture for other outcomes can come later, as a new key or an opt-in.
- **The restrictions stay.** Instructions, skills, connections, and subagents still run only at `session.start` and `turn.start`.
- **Framework work moves onto points too.** The skill and connection announcements and the framework connection tools run at `model.start` as built-in participants, instead of as special cases on `step.started`.

### What a handler receives

The handler shape `(point, ctx)` and the `defineDynamic({ events })` container key don't change. Only the first argument becomes typed:

```ts
type ParticipantPoint =
  | { point: "session.start"; entry: Entry }
  | { point: "turn.start"; turnId: string; entry: Entry }
  | { point: "model.start"; turnId: string; runId: string; entry: Entry }
  | { point: "compaction.start"; turnId?: string; runId: string; entry: Entry }
  | { point: "compaction.complete"; turnId?: string; runId: string; entry: Entry }
  | { point: "turn.complete"; turnId: string; entry: Entry };

type Entry = "initial" | "restore" | "redeploy";
```

- **`entry`** says why the point is running:
  - `initial` the first time;
  - `restore` when a parked step, a callback, or an approval resumes;
  - `redeploy` when a newer deployment refreshes session-scoped results.

  Resolvers should stay idempotent, as the docs already ask. `entry` lets them skip expensive work when they know they're restoring.

- **Points carry their IDs explicitly,** rather than having the runner read them from the projection, so a restore can't pick up the wrong turn.
- **`ctx` (`DynamicResolveContext`) is unchanged:** session, auth, channel, conversation, messages, and the effective model.
- **The aliases** map each old key to its point. A handler registered under `turn.started` receives the same typed point as one registered under `turn.start`. Memory providers' `recall` and `capture` maps accept both spellings.

### One pipeline

```text
harness/participants/
  points.ts     the point catalog and its payload types
  registry.ts   participants and the points they accept, built once from the bundle
  run.ts        runParticipants(point, ctx): runs participants in a fixed order and records results
```

- **Transitions declare points** alongside the facts they write. The step that applies a transition calls `runParticipants` for each point it declared, after the commit is written.
- **One fixed order:** memory first, then the dynamic model, connections, subagents, tools, skills, and instructions, which is today's order. Today's failure rules stay; for example, a throwing `recall` on `turn.start` fails the turn before the model runs.
- **Re-entry uses the same function.** Every path in the synthetic-events table calls `runParticipants` with `entry: "restore"` or `"redeploy"`.
- **Results are recorded as today,** in the same durable keys, so a restore reuses locked identities instead of re-resolving against the current configuration.

**Deleted:**

- `harness/session-machine/resolver-events.ts`, and its `modelId: "dynamic"` placeholder;
- the six type-filtered dispatch calls in `turn-event-handler.ts`;
- the memory type switch in `context/memory-event-lifecycle.ts`;
- the `step.started` skip and special cases in the model, skill, and connection dispatchers;
- the scattered `ALLOWED_DYNAMIC_*` sets, replaced by the registry's declaration of which points each participant accepts.

### One ordering change

Today memory runs between the write and the hooks, while the dynamic resolvers run after the hooks. In the pipeline, every participant runs after the commit's observers. The difference isn't visible to hooks, because they never see model messages or memory results. The only effect: a hook that cancels the turn from `turn.started` now stops memory recall from running for a turn that won't call the model.

## Compatibility

- **Authored code keeps compiling.** Old keys are aliases, and timing and semantics don't change. The typed point is assignable wherever `unknown` was accepted.
- **Extension contracts.** The retained epochs for dynamic tools (58), instructions (28), and skills (27) still pass, because the old keys still exist. The new keys add an epoch per capability.
- **Docs** switch to the new names: the dynamic capabilities guide, the custom memory provider guide, and examples. The old names stay documented as aliases.
- **Deprecation** of the aliases is a separate decision, and not needed for 1.0.

## Plan

1. **Land after HumanInput (#4342–#4344).** The pipeline touches `execution/session/turn-step.ts`, `harness/model-call/run.ts`, and `harness/hitl/intake.ts`, all of which HumanInput changes.
2. **Add the catalog, the typed points, and the aliases.** Authored code doesn't change.
3. **Move dispatch onto the pipeline,** one participant at a time, with today's scenario tests pinning order and timing per point: memory recall before the first model call, dynamic model selection per model call, rebinding after a redeploy, restoring a parked step's tools.
4. **Switch the docs.**

**Size:** a small net reduction, not measured. The dispatch and synthetic-event code it removes is a few hundred lines across `turn-event-handler.ts` (140), `resolver-events.ts` (29), `memory-event-lifecycle.ts` (76), and the filtering parts of the six `context/dynamic-*-lifecycle.ts` files. The pipeline adds back something smaller.

## Open questions

1. **Is the ordering change acceptable?** The alternative is for the turn step to run memory between the write and the hooks, as today. That keeps a second, special-cased path into the pipeline.
2. **How long do the aliases last?** Keeping them through 1.x costs little. Deprecating them with a warning would let the docs drop the old names sooner.
3. **Memory capture for turns that fail or are cancelled** is deliberately absent. If providers ask for it, it can come as a new point or an opt-in.
