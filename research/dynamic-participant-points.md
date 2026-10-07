---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-07"
---

# Dynamic participant points

Read on `main` at `285d4e09b`. Nothing was prototyped.

## Summary

Dynamic resolvers (`defineDynamic({ events })`) and memory providers key their handlers on stream event names: `session.started`, `turn.started`, `step.started`, `compaction.requested`, `compaction.completed`, `turn.completed`, but they don't actually observe the underlying stream. The state machine needs to create fake non-published events to drive these resolvers. Sometimes, these are replays of events that have already been published, and sometimes they're previews of events that are about to be published.

There are a few problems with this approach:

- Conceptual inaccuracy
  - Using the `events` key and using the name of existing events implies that these are essentially hooks that are consuming the real session stream. We have an `event` parameter for these APIs that implies that you are getting access to a raw stream event, but it's generally not a 1-1 mapping with the real event (it will be missing meta fields, for example)
  - We sometimes run this code before the actual underlying event is produced, so it's possible to act on an "event" that never enters the stream
- Implementation complexity
  - We have spaghetti code to maintain these different synthetic event dispatch things

This doc proposes, before 1.0:

- A well-defined catalog of points (`session.start`, `turn.start`, `model.start`, `compaction.start`, `compaction.complete`, `turn.complete`). These are distinct from the stream's facts.
- A single pipeline for running each of the consumers of this interface, replacing the synthetic events and distributed dispatch code.

In essence, we should stop lying about which parts of the system are reacting to events on the durable stream (**observers**) and which parts of the system are participating in the state machine, taking effect at different parts of the lifecycle (**participants**).

These changes aren't on the critical path for [`session-event-lifecycle.md`](./session-event-lifecycle.md), and either can land first. However, that proposal removes `step.started`, `turn.completed`, and `compaction.*` from the stream. Without this change, participant keys would keep naming facts that no longer exist.

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

Instructions, skills, connections, and subagents are limited to session and turn boundaries, so the model's input doesn't change between tool-loop steps. The rule is enforced in different places for each:

| Participant  | `defineDynamic` from   | Checked at build                                      | Checked at runtime                                       |
| ------------ | ---------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Tools        | `eve/tools`            | Typed map; all three keys allowed                     | `ALLOWED_DYNAMIC_TOOL_EVENTS`                            |
| Model        | `eve`                  | Typed map; all three keys allowed                     | `ALLOWED_DYNAMIC_MODEL_EVENTS`                           |
| Instructions | `eve/instructions`     | Typed map, plus `normalize-instructions.ts`           | `ALLOWED_DYNAMIC_INSTRUCTION_EVENTS`                     |
| Connections  | `eve/connections`      | Typed map, plus `normalize-connection.ts`             | `ALLOWED_DYNAMIC_CONNECTION_EVENTS`                      |
| Subagents    | `eve`                  | `normalize-subagent.ts`, with its own copy of the set | A second copy in `context/dynamic-subagent-lifecycle.ts` |
| Skills       | `eve/skills`           | None: the shared type allows `step.started`           | `ALLOWED_DYNAMIC_SKILL_EVENTS`                           |
| Memory       | `defineMemoryProvider` | Typed `recall` and `capture` maps                     | An if/else chain on the event type                       |

A skill resolver keyed on `step.started` compiles, then silently never runs.

### How they're dispatched

**Published events.** `execution/session/turn-event-handler.ts` runs for every event a turn publishes, including each streamed delta, in this order:

1. write the event (channel adapter, then the stream);
2. memory, through the type checks in `dispatchMemoryLifecycleEvent`;
3. hooks;
4. the dynamic model, skipped for `step.started`;
5. connections, subagents, tools, skills, and instructions.

Each dispatcher in steps 4–5 checks its own allowed set and returns early for everything else. Some add special cases:

- tools take a separate branch for `step.started`, reset step metadata on `turn.started`, and clear durable callbacks on `session.completed`;
- skills let `step.started` through to rebuild their announcement, then filter it out before any resolver runs;
- the connection wrapper in `execution/dynamic-connections.ts` announces connections on `step.started`;
- the model dispatcher maps each event type to a durable key, and `step.started` to none.

**Synthetic events.** Several paths need participants to run when nothing is being published. They rebuild an event by hand with the v26 builders, from `harness/session-machine/resolver-events.ts`. Each is a replay of an event published earlier, or a preview of one about to be published, with approximate fields:

| Path                      | Where                                                  | Rebuilds                          | Differs from the real event                                                  |
| ------------------------- | ------------------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------------- |
| Model selection           | `harness/model-call/run.ts` `selectModel`              | `step.started`, ahead of time     | `modelId` is the static model or `"dynamic"`, since choosing it is the point |
| Redeploy refresh          | `execution/session/turn-step.ts`                       | `session.started`                 | The current deployment's runtime identity; no trace context                  |
| Callback rebind           | `execution/session/turn-step.ts`                       | `turn.started`                    | Replayed in a later step or process                                          |
| Approval turn preparation | `execution/session/turn-step.ts` `prepareApprovalTurn` | `turn.started`, for connections   | Replayed in a later step or process                                          |
| Connection rehydrate      | `execution/dynamic-connections.ts`                     | `session.started`, `turn.started` | Replayed in a later step or process                                          |
| Parked-step tool restore  | `harness/hitl/intake.ts`                               | `step.started`                    | `modelId` placeholder                                                        |

None of them carries `meta` or `at`. Memory never receives one; it runs only on published events.

The pattern is as old as dynamic model selection (#581), which had to choose the model before the model call that the published `step.started` records. Recovery fixes added the replays one at a time (#1133, #1370, #2384, #2738, #2751, #3763, #3983). #4177 gathered them into `resolver-events.ts`.

**Untyped payloads.** A handler's first argument is `unknown` (`DynamicEvents` in `dynamic/definition.ts`). The docs tell authors to read messages from `ctx` and say only that "the event itself contains turn metadata".

### What that costs

- **The names promise stream facts that aren't there.** A resolver's `step.started` fires before the model call that the published `step.started` describes, and replays carry approximate data.
- **Participant keys break whenever the stream vocabulary changes.** At v27 that would mean either an authored break for every dynamic resolver and memory provider, or keys that name facts that no longer exist.
- **Dispatch is scattered:**
  - six type-filtered dispatch calls, run for every published event, deltas included;
  - allowed sets in several files, one of them duplicated, and one participant with no build-time check;
  - special cases for `step.started`;
  - each re-entry path choosing which event to rebuild.
- **Authors can't rely on the payload,** because it's typed `unknown`.

## Proposal

### The API

Handlers move from `events` to `resolve`, keyed by point:

```ts
// agent/tools/catalog.ts
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  resolve: {
    "session.start": async (_point, ctx) => ({
      search: defineTool({/* … */}),
    }),
    "model.start": async ({ entry }, ctx) =>
      entry === "restore" ? null : toolsForMessages(ctx.messages),
  },
});
```

```ts
// agent/agent.ts
export default defineAgent({
  model: defineDynamic({
    resolve: {
      "session.start": (_point, ctx) => modelForPlan(ctx.session.auth),
      "model.start": (_point, ctx) => (hasImages(ctx.messages) ? visionModel : null),
    },
  }),
});
```

Memory providers keep their `recall` and `capture` containers, keyed by the same points:

```ts
defineMemoryProvider({
  recall: { "turn.start": recallForTurn, "compaction.complete": recallAfterCompaction },
  capture: { "turn.complete": captureTurn, "compaction.start": captureBeforeCompaction },
});
```

Migrating is mechanical:

```ts
// before
defineDynamic({ events: { "step.started": (_event, ctx) => pick(ctx.messages) } });
// after
defineDynamic({ resolve: { "model.start": (_point, ctx) => pick(ctx.messages) } });
```

- **Why `resolve`.** Memory already names its containers after the action and keys them by point. `resolve` does the same, and the docs already call these handlers resolvers. `on` reads like a listener, which is what this moves away from; `points` names our concept rather than what the author does; dropping the container would collide with the agent variant's `build` option.
- **Every entry point is typed to the points its participant accepts.** `eve/skills` and the subagent form of `eve`'s `defineDynamic` get their own typed variants, so a skill handler on `model.start` is a type error instead of a resolver that never runs.
- **No aliases.** Authors touch every resolver to rename the container anyway, and two vocabularies would outlive their purpose in the types, docs, and registry. Instead, the old shape fails the build with the exact rename ([Compatibility](#compatibility)).

### The point catalog

Timing is unchanged from today.

| Point                 | Runs                                                   | Participants                                                       | Replaces               |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------- |
| `session.start`       | After the session's opening commit                     | Dynamic model, tools, instructions, skills, connections, subagents | `session.started`      |
| `turn.start`          | After the turn's opening commit                        | Memory recall and memory tools, then the dynamic ones              | `turn.started`         |
| `model.start`         | Before each responding model call                      | Dynamic model and tools                                            | `step.started`         |
| `compaction.start`    | Before the compaction run                              | Memory capture                                                     | `compaction.requested` |
| `compaction.complete` | After compaction replaces the context, on success only | Memory recall                                                      | `compaction.completed` |
| `turn.complete`       | After the turn settles `completed`, on success only    | Memory capture                                                     | `turn.completed`       |

- **`model.start`** runs before every model call a turn makes to respond, including after tool results, task results, approvals, steering, and a completed sign-in. It doesn't run for each provider retry inside one call. The stream's `model.started` fact then records the model that was chosen.
- **`*.complete` means the phase completed normally.** Failed or cancelled turns and compactions have no complete point, which matches today's memory semantics. Capture for other outcomes can come later, as a new point or an opt-in.
- **The restrictions stay.** Instructions, skills, connections, and subagents still run only at `session.start` and `turn.start`.
- **Framework work moves onto points too.** The skill and connection announcements and the framework connection tools run at `model.start` as built-in participants, instead of as special cases on `step.started`.

### What a handler receives

The handler shape stays `(point, ctx)`. The first argument becomes typed:

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
- **`ctx` (`DynamicResolveContext`) is unchanged:** session, auth, channel, conversation, messages, and the effective model. Memory handlers keep their single context argument.

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
- **Published deltas no longer reach participants.** Only declared points run them.
- **Results are recorded as today,** in the same durable keys, so a restore reuses locked identities instead of re-resolving against the current configuration.
- **Stored scope names don't change.** Dynamic tool callbacks persist their scope as `session`, `turn`, or `step`, today derived from the key (`event.type.split(".")[0]`). The registry maps each point to the scope already stored, `model.start` to `step`, so a session that spans the deploy restores its locked tools.

**Deleted:**

- `harness/session-machine/resolver-events.ts`, and its `modelId: "dynamic"` placeholder;
- the six type-filtered dispatch calls in `turn-event-handler.ts`;
- the memory type checks in `context/memory-event-lifecycle.ts`;
- the `step.started` skip and special cases in the model, tool, skill, and connection dispatchers;
- the `ALLOWED_DYNAMIC_*` sets in the runtime and the compiler, replaced by the registry's declaration of which points each participant accepts.

### One ordering change

Today memory runs between the write and the hooks, while the dynamic resolvers run after the hooks. In the pipeline, every participant runs after the commit's observers. The difference isn't visible to hooks, because they never see model messages or memory results. The only effect: a hook that cancels the turn from `turn.started` now stops memory recall from running for a turn that won't call the model.

## Compatibility

This is a breaking change for authored code, so it should ship in the same release as the event break ([`session-event-lifecycle.md`](./session-event-lifecycle.md#compatibility-at-the-break)), so authors migrate once.

- **The old shape fails the build with the fix.** A `defineDynamic` with `events`, or a memory provider keyed by an old name, gets an error naming the exact rename, for example `` `events` is now `resolve`; rename "step.started" to "model.start" ``. It's an error, not an alias, and it can be removed after a release or two.
- **A codemod** handles the rest: the container rename, then six one-to-one key renames.
- **Running sessions aren't affected.** Key names aren't persisted, and stored scope names stay as they are.
- **Extension contracts.** Retained epochs whose fixtures author `defineDynamic({ events })` are dropped with a reason: 55 for dynamic tools, 28 for instructions, 27 for skills, 8 for subagents, and 5 for connections. Each capability gets a new epoch.
- **Third-party extensions and memory providers** built against the old API break until they update.
- **In this repo,** the migration covers:
  - about 51 e2e fixture files;
  - 17 framework source files, such as the connection and memory tools;
  - a few docs pages, two templates, `eve-code`, and one app fixture.
- **Docs** switch to the new names: the dynamic capabilities guide, the custom memory provider guide, and examples.

## Plan

1. **Land after HumanInput (#4342–#4344).** The pipeline touches `execution/session/turn-step.ts`, `harness/model-call/run.ts`, and `harness/hitl/intake.ts`, all of which HumanInput changes.
2. **Add the pipeline behind today's API.** The catalog, the registry, and `runParticipants`, with the existing keys mapped onto points internally. Then move dispatch onto it one participant at a time, with today's scenario tests pinning order and timing per point:
   - memory recall before the first model call;
   - dynamic model selection per model call;
   - rebinding after a redeploy;
   - restoring a parked step's tools.

   This part changes nothing for authors and can land on its own.

3. **Rename the API in the event break's release:** `resolve`, the point keys, typed entry points, the build error, the codemod, and the repo migration.
4. **Switch the docs.**

**Size:** a small net reduction, not measured. The dispatch and synthetic-event code it removes is a few hundred lines across `turn-event-handler.ts` (140), `resolver-events.ts` (29), `memory-event-lifecycle.ts` (76), and the filtering parts of the six `context/dynamic-*-lifecycle.ts` files. The pipeline adds back something smaller.

## Open questions

1. **Is the ordering change acceptable?** The alternative is for the turn step to run memory between the write and the hooks, as today. That keeps a second, special-cased path into the pipeline.
2. **Memory capture for turns that fail or are cancelled** is deliberately absent. If providers ask for it, it can come as a new point or an opt-in.
