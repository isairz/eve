---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-06"
---

# Session event model

## Summary

Every eve reader folds the same session stream: web and React clients, the dev TUI, Slack and the other channels, evals, ACP, the invocation API, authored hooks, and the server itself. Understanding that stream takes more than `protocol/message.ts`:

- An approval's outcome is spread across three events.
- A tool's receipt is easy to read as its outcome.
- Response completion is inferred from turn boundaries.
- Which text is the reply is read from `finishReason` on a text block.
- Most payloads repeat `turnId`, `sequence`, and `stepIndex`, and what those mean depends on the event.

This doc proposes a stable contract for the next stream-version break:

- **Eight entities**, each with an ID, immutable ownership, and one terminal event with a closed outcome set.
- **Checkable invariants** and explicit delivery completion, call outcomes, interaction resolution, and reply references.
- **One commit per stream line**, with immutable positions.
- **Additive evolution:** new kinds, fields, families, and annotations; tolerant readers and declared fallbacks ([Evolution rules](#evolution-rules)).

The catalog has 27 event types (24 durable facts and 3 streaming progress types), where v26 has 34. The schemas are Zod, in one self-contained module.

Compatibility is cut on purpose: v27 clients read v27 only, and sessions don't cross the break. A read-through of `main` puts the net change at roughly 500–1,000 fewer source lines out of about 10,000 touched. Test updates dominate the effort ([Implementation estimate](#implementation-estimate)).

The contract was pressure-tested against eve's roadmap and open issues ([Pressure test](#pressure-test)).

## Baseline and scope

This builds on the session-state stack, which merged into `main` as #4177 (`4bef05e9d`), and its research doc, #4067. That stack gives eve:

- one fold over published events (`foldSession`);
- transitions that are the only builders of lifecycle events;
- one commit order: publish, fold, run hooks, save.

The stack narrowed to stream v26 and deferred four changes. Each one would patch v26 vocabulary that this contract replaces, so they land here as families of one contract:

| Deferred from the stack                            | Lands here as                                |
| -------------------------------------------------- | -------------------------------------------- |
| Complete each response at its delivery's boundary  | Delivery facts and the finish rule           |
| Precise outcomes for stopped calls                 | `call.settled` outcomes and explicit closure |
| Evals that distinguish receipts from work outcomes | `call.delegated` and one `call.settled`      |
| Owner versus origin for relayed requests           | `interaction.opened` `subject` and `origin`  |

HumanInput (#4342, #4343, #4344) rewrites human-in-the-loop handling as one reducer behind `harness/hitl/`. The interaction family follows its request model ([Interactions](#interactions)). Its reducer structure can later move onto the session machine, with lifecycle read from the projection rather than kept in private state.

Execution machinery, HITL authorization rules, and storage are out of scope; [Private state](#private-state) covers only the boundary.

## What readers guess today

| Readers guess                            | Example                                                                                                                                                                                                                                               | Rule that removes the guess                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A call's status, from six event types    | In the shared fold (#4141), `approval.settled` uses `cancelled` for a responder's decline, so HTTP denials read as withdrawals. `input.resolved` settled a call before the `action.result` that carried the denial reason, so ACP dropped the reason. | One terminal per entity; no fold case changes a second entity  |
| A work outcome, from the model's receipt | Evals count a task call `completed` from its receipt even when the task was cancelled. Slack's task cards special-case receipts so a task call keeps running until `task.settled`.                                                                    | One `call.settled` carries the outcome and the output          |
| A response's end, from turn boundaries   | `respond()` keeps a first-boundary fallback, because answers routed through tools, workflows, and child sessions publish outside the turn step and lose `meta.deliveryIds`.                                                                           | Deliveries are entities with a terminal                        |
| Which text is the reply                  | About a dozen channel defaults, evals, the invocation API, and the client read `message.completed.finishReason !== "tool-calls"`. Text in a held step is reported as `tool-calls` to hide it.                                                         | `content.completed.phase` and `turn.settled.reply`             |
| Queued versus received                   | A message held behind the budget prompt needed an "announced?" flag.                                                                                                                                                                                  | `delivery.accepted` and `delivery.consumed` are separate facts |
| An entity nobody introduced              | A resumed approved call's result arrived with no prior request. A tool call with invalid input gets a failed `action.result` without ever appearing in `actions.requested`.                                                                           | Introduce before reference                                     |
| An ending nobody recorded                | A call still running when its turn is cancelled reads `interrupted` by inference, so pruning never drops it. `context.cleared` has no fold case.                                                                                                      | Owners close their children explicitly                         |
| What coordinates mean                    | `main` relays a child's request at the child's turn and step; the stack's first version moved it to the parent's serving call. Both are reasonable, but one field can't carry both meanings.                                                          | Typed `subject` and `origin`                                   |

## Entities and invariants

| Entity       | Meaning                                                            | Owner, declared at introduction                   |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------- |
| Session      | Durable conversation and its ongoing work                          | Parent call, when delegated                       |
| Delivery     | One submitted message, answer, or control request                  | Session                                           |
| Turn         | Agent work that can pause and resume                               | Session; caused by a delivery or callback         |
| Model run    | One logical model invocation                                       | Turn                                              |
| Content part | One block of model output: text, reasoning, or a structured result | Model run                                         |
| Call         | One invocation of a tool, agent, or skill                          | Model run, or parent call when nested             |
| Task         | Work that outlives an immediate return                             | The call that started it; it can outlive its turn |
| Interaction  | An approval, question, sign-in, or budget prompt                   | Subject: a call, task, turn, or candidate         |

Responders' answers to a policy-gated approval are subordinate candidates of their interaction. When a call or task opens a child session, the parent records it as a link (`child.opened`); the child's lifecycle lives in its own stream.

```text
Session
├─ Delivery ──consumed into──▶ Turn           (a message's parts ride on delivery.consumed)
├─ Turn (cause: delivery or callback; follows: an earlier turn)
│    ├─ Model run (purpose: respond | compact)
│    │    ├─ Content part
│    │    └─ Call ──delegated to──▶ Task
│    │         ├─ Call (nested)
│    │         └─ Interaction (approval) ──settled by──▶ Delivery
│    │              └─ Candidate
│    └─ Interaction (sign-in, budget)
└─ Task (can outlive turns)
     ├─ Interaction (question, sign-in)
     └─ Child session link
```

Invariants:

1. **One entity per fact.** A fact's type names its entity family, and its payload carries that entity's ID. Each fold case updates one table.
2. **Introduce before reference.** A fact references an entity only after the fact that introduces it. Progress may announce an ID first: `content.delta` and `call.input` stream before the fact that introduces their entity. An entity's owner never changes.
3. **Exactly one terminal.** Each entity has one terminal event type, with an outcome from a closed set specific to that entity. A person can decline an interaction; a model run can't be declined.
4. **Explicit closure.** When the machine ends an owner, it emits terminals for the children it ends, in the same commit and before the owner's terminal. Tasks, and interactions that belong to tasks, are declared to outlive turns.
5. **Decisions, not inferences.** A fact records a machine decision or an accepted observation. No reader derives lifecycle from output text, `isError`, a missing event, or progress.
6. **Joins are selectors.** State that spans entities, such as a call awaiting input or an idle session, is computed, not stored. A machine decision is still a fact even when it could be derived: `turn.paused` records that the machine parked.
7. **Progress is bounded by its owner.** Progress never enters the lifecycle fold, and a completing fact replaces it. When the machine stops an owner deliberately, it completes in-flight parts with what streamed (`interrupted`). Only an owner superseded by a retry (`abandoned`) leaves incomplete progress behind ([Content](#content)).
8. **References, not internals.** Facts carry eve-owned IDs and resource references. They never carry secrets, resolved credentials, workflow or node IDs, dispatch variants, or raw bytes. The one server-internal exception is `child.opened.remote` ([Child sessions and relays](#child-sessions-and-relays)).
9. **Transitions are the only writers.** Every fact comes from one transition's output. One transition is one commit, and one commit is one stream line.
10. **At most one open turn per session.** A paused turn counts as open. Concurrency comes from tasks and child sessions.

A stream checker enforces invariants 2–4 and 10 over test streams. It also flags anything the fold's tolerance rules would absorb ([Writers, retries, and recovery](#writers-retries-and-recovery)). Each family module declares `{ idField, introducedBy, terminal, owner }`, so the checker, the event reference docs, and pruning can all be generic. That descriptor is metadata, not a state-machine language.

There are three kinds of records:

|             | Facts                                | Progress                                       | Private records                                 |
| ----------- | ------------------------------------ | ---------------------------------------------- | ----------------------------------------------- |
| Examples    | `call.settled`, `interaction.opened` | `content.delta`, `call.input`, `call.progress` | Suspended steps, answer routes, grants, history |
| On the wire | Yes, grouped by commit               | Yes, one per line                              | Never                                           |
| Folded into | The shared projection                | Nothing                                        | Execution state                                 |

## Contract module

The schemas are Zod, with types inferred from them, in one module that imports nothing from runtime code:

```text
protocol/session-events/
  envelope.ts          stream line, fact and progress envelopes, IDs, scope, cause,
                       principal, error, usage, value references
  families/            session, delivery, turn, model, content, call, task,
                       interaction, child, context
                       each: payload schemas + descriptor {idField, introducedBy, terminal, owner}
  catalog.ts           unions, type → family, descriptor table, open-enum fallbacks
  checker.ts           invariant checker for test streams
protocol/session-projection/   fold per family, public tables, selectors
```

- **No runtime types.** A guard forbids imports from `shared/`, `harness/`, `connections/`, or `ai`, so runtime refactors cannot silently change the wire.

- **No builders in `protocol/`.** Facts are typed literals built by their owners: the session machine and `hitl/` for lifecycle, and the emission files for streamed content and calls.
- **Validation runs in tests and dev only.** Payloads are validated there and in the checker. Clients import types only, so nothing is validated on the delta hot path.
- **No strict parsing on cross-version paths** ([Evolution rules](#evolution-rules)).
- **Authoring maps are checked against the catalog.** The hook and channel maps stay explicit, so new events don't silently become hook events, but they are type-checked against the catalog.

## Wire format

```ts
type StoredLine =
  | { at: string; facts: readonly Fact[] } // one commit
  | { progress: Progress }; // one delta or snapshot

interface Fact {
  type: FactType;
  scope?: Scope;
  data: FactData;
}
interface Progress {
  type: ProgressType;
  scope?: Scope; // on the announcing record only
  data: ProgressData;
}
interface Scope {
  turnId?: string;
  taskId?: string;
  runId?: string;
}
```

- **A line is one stored chunk.** The writer stores one chunk per write, so a commit is atomic on the stream. A crash leaves the whole commit or none of it.
- **Positions.** A position is the zero-based index of a line in the session's durable stream: the number of lines stored before it.
  - **Immutable.** Positions are never reused or renumbered, even under a future retention policy.
  - **Shared within a commit.** Every fact in a commit shares that line's position.
  - **The same values as Workflow.** Positions are Workflow chunk indexes and use the same values as `startIndex`.
- **Clients count lines.** Lines carry no position field, and facts and progress carry no event IDs. Entity IDs carry the meaning, and a fact's identity is its position plus its index within the line.
  - **Dedupe:** the client deduper becomes `position > last`. It handles reconnect overlap, rewinds, and merging a cached log, all of which repeat deliveries of the same line.
  - **Not dedupe:** a fact written twice, for example by a retried step, is two lines. That's the fold's job ([Writers, retries, and recovery](#writers-retries-and-recovery)).
- **Catch-up skips closed progress by default.** A read that opens behind the tail sends progress only for entities still open at the tail it observed when it opened, and omits the rest.
  - To keep lines in order, the server holds lines back from the first still-open entity's first progress line, and drops progress for entities that close before the tail.
  - When the omitted range ends, the server sends `{"$eve":"position","next":N}`. Every line after it is contiguous, so the client counts on from `N`, and lease reconnects resume exactly.
  - If the connection drops before that record arrives, the client redoes the catch-up from its previous cursor.
  - A full mode, which omits nothing, remains available, for example for `eve logs --events`.
- **Transport records aren't lines.** Anything with an `$eve` key (lease end, position) and blank heartbeat lines is transport, never counted.
- **Facts are never omitted for a particular reader; sensitive fields may be redacted in place.** That keeps positions global.
- **Progress rules:**
  1. Progress for closed entities may be skipped.
  2. Delta granularity is unspecified. Consecutive progress for an entity may be merged, so coalescing can be added or tuned later as a producer change.
  3. Any progress kind may be absent. Completing facts always carry the full value.
  4. The first progress record for an entity announces it, with its kind or name and owner scope. Later records are minimal (`{partId, delta}`) and carry no `at` or `scope`.
  5. `call.progress` is a bounded snapshot; the latest replaces earlier ones.
- **Line order is the order.** `at` only informs.
- **`meta.deliveryIds` goes away.** Deliveries are entities.
- **The publisher stamps `scope`** from the entity's owners: its nearest turn, task, and model run. Owners never change, so scope never goes stale. It lets readers that don't fold place a fact without a projection, such as log pipelines and eval matchers.

Envelope cost matters because progress dominates line counts.

| Shape                  | Bytes for a 5-character delta |
| ---------------------- | ----------------------------- |
| v26 `message.appended` | 233                           |
| Minimal v27 progress   | about 105                     |

Since Workflow 5, `write()` resolves when a chunk is buffered, so eve's emitter rarely merges deltas. HTTP-only sessions likely store about one line per provider delta; that hasn't been measured. Reasoning deltas stay as progress, because the durable stream is the only live path to HTTP clients (the web client and ACP render reasoning as it streams). An agent-level opt-out can come later, keeping the announcing record so clients still show "thinking…".

## Event catalog

```text
ENTITY         INTRODUCED BY        NON-TERMINAL                       TERMINAL
Session        session.started      —                                  session.closed
Delivery       delivery.accepted    delivery.consumed                  delivery.finished
Turn           turn.started         turn.paused · turn.resumed         turn.settled
Model run      model.started        —                                  model.settled
Content part   content.completed    content.delta~ (announces)         content.completed
Call           call.requested       call.input~ (announces)            call.settled
                                    call.delegated · call.progress~
Task           task.started         —                                  task.ended
Interaction    interaction.opened   —                                  interaction.settled
 └ candidate   candidate.opened     —                                  candidate.settled
Child session  child.opened         —                                  (in the child's stream)
Context        —                    context.compacted · context.cleared

~ progress: streamed between commits, never folded.
```

Each v26 event maps to the catalog like this:

```text
v26                              PROPOSED
session.started ───────────────▶ session.started        parent?: {sessionId, callId}
session.completed ─┬───────────▶ session.closed         {completed | failed}
session.failed ────┘
session.waiting ───────────────▶ ✕ idle is a selector; channels get an idle callback;
                                   responses end at delivery.finished; usage is a selector
(meta.deliveryIds) ────────────▶ delivery.accepted · delivery.consumed · delivery.finished
message.received ──────────────▶ delivery.consumed      {turnId, parts}

turn.started ──────────────────▶ turn.started           {cause, follows}; no sequence
turn.waiting ──────────────────▶ turn.paused            {awaiting: refs}
(next step.started) ───────────▶ turn.resumed           {cause}
turn.completed ─┐
turn.failed ────┼──────────────▶ turn.settled           {completed | failed | cancelled, reply?}
turn.cancelled ─┘

step.started ──────────────────▶ model.started          {runId, purpose: respond, modelId}
step.completed ─┬──────────────▶ model.settled          {outcome, finishReason, usage, generationId}
step.failed ────┘
compaction.requested ──────────▶ model.started          {purpose: compact, trigger}
compaction.completed ──────────▶ model.settled + context.compacted
context.cleared ───────────────▶ context.cleared        {cause}

message.appended ──────┐
reasoning.appended ────┴───────▶ content.delta~         {partId, kind, delta}
action.input.appended ─────────▶ call.input~            {callId, name, delta}
message.completed ───┐
reasoning.completed ─┼─────────▶ content.completed      {partId, kind, value, phase, interrupted?}
result.completed ────┘

actions.requested ─────────────▶ call.requested         one per call; capability, not dispatch
action.partial ────────────────▶ call.progress~
action.result ─────────────────▶ call.settled           the only place a call's output appears
task.started ──────────────────▶ task.started (once) + call.delegated (every call it serves)
task.settled ──────────────────▶ call.settled (+ task.ended when the task stops)
agent.started ─────────────────▶ child.opened

input.requested ─────────┐
authorization.required ──┴─────▶ interaction.opened     {kind: approval | question | budget | sign-in}
input.resolved ──────────┐
approval.settled ────────┼─────▶ interaction.settled    one terminal; outcome from one closed set
authorization.completed ─┘
approval.candidate ────────────▶ candidate.opened · candidate.settled
```

Terminal outcome sets are closed for the life of the major version. Each word means the same thing in every family ([Evolution rules](#evolution-rules)):

| Terminal              | Outcomes                                                |
| --------------------- | ------------------------------------------------------- |
| `session.closed`      | completed, failed                                       |
| `delivery.finished`   | settled, paused, applied, ignored, refused, failed      |
| `turn.settled`        | completed, failed, cancelled                            |
| `model.settled`       | completed, failed, interrupted, abandoned               |
| `call.settled`        | completed, failed, rejected, interrupted                |
| `task.ended`          | completed, failed, cancelled                            |
| `interaction.settled` | accepted, declined, invalid, failed, withdrawn, expired |
| `candidate.settled`   | accepted, refused, failed, expired, withdrawn           |

## Semantics

### Calls

```text
call.input~     { callId, name, delta }                     announces the call
call.requested  { callId, owner: {runId} | {callId}, capability: {kind, name, title?}, input? | inputError? }
call.delegated  { callId, taskId }                          a task serves this call
call.progress~  { callId, output }                          bounded snapshot; the latest replaces earlier ones
call.settled    { callId, outcome, output? | outputOf?, error?, reason?, cause?, usage? }
```

- **Output appears once, on `call.settled`.** What the model saw as the call's result isn't published separately:
  - for a sync call, it is the output;
  - a task call's receipt is implied by `call.delegated`;
  - denial and cancel text follows from `reason`.

  The model sees a task's result later, rendered into a `task.result` history message that clients never read; they read the structured output. `input` and `output` may be inline or a reference ([Evolution rules](#evolution-rules)).

- **Outcomes:**
  - `completed`;
  - `failed`, for an execution error or invalid input;
  - `rejected`, with `cause: {interactionId}` or `{policy}`;
  - `interrupted`, with reason `turn-cancelled`, `authorization-required`, or `attempt-abandoned`.
- **Calls settle by what actually happened.** If a call ran before its model run was abandoned (the AI SDK runs tools while it streams), it settles `completed` or `failed`. The run's `abandoned` outcome already says its results never reached the model.
- **Nested calls never enter history.** These are, for example, the connection calls `connection_execute` makes. They have `owner: {callId}`, and their output still appears on their own `call.settled`, for activity views and evals.
- **Streamed input:**
  - `call.input` announces the call's ID and tool name from the first delta.
  - `call.requested` introduces the call with validated input.
  - When validation fails, `call.requested` carries `inputError` instead of `input`, and `call.settled` follows with `failed`, so every call the model made is introduced.
  - If the run ends first, `model.settled` abandons the announced call; a call that was never requested never ran.
- **Sign-ins:** a call that needs a sign-in settles `interrupted` with reason `authorization-required`. After the sign-in the model calls again, and that is a new call.
- **Capability, not dispatch:** `capability.kind` is open (`tool`, `agent`, `skill` today). Whether a call runs inline, as a workflow, remotely, or at the provider is private.

### Tasks

```text
task.started    { taskId, startedBy: {callId}, kind: agent | tool, name }
call.delegated  { callId, taskId }                          every call the task serves, including the first
call.settled    { callId, outcome, output? | outputOf? }
task.ended      { taskId, outcome: completed | failed | cancelled, reason? }
```

- **One start, one end.** `task.started` fires once, when the first call starts the task. Each call the task serves gets `call.delegated` and later its own `call.settled`.
- **One reply, several calls.** A `serve` task's `ctx.reply(output)` settles every call received so far with one output. The first call's `call.settled` carries the output, and the others carry `outputOf: {callId}`.
- **When it ends.** `task.ended` fires when the body returns or throws, 30 s after a cancel it doesn't return from, or when the session ends, before `session.closed`.
- **Working versus idle** is a selector: a task is working while any of its delegated calls is unsettled.
- **This replaces** the per-call `task.started` and `task.settled` in [`eve-tasks.md`](./eve-tasks.md).

### Interactions

The family follows HumanInput's request model: one interaction per request.

```text
interaction.opened  { interactionId, subject, request, origin?, audience? }
interaction.settled { interactionId, outcome, reason?, cause?, response? }
candidate.opened    { candidateId, interactionId, principal }
candidate.settled   { candidateId, outcome, reason? }
```

- **Requests render without knowing their kind.** Every request carries `{kind, prompt, title?, options?, allowFreeform?, display?, link?}`, extending today's `InputRequest`, plus kind-specific fields. A client can render and answer any kind, including kinds added later, by option or free text.
- **One closed outcome set for every kind.** Kind-specific detail rides on `response`, and clients that know a kind still say "Approved" or "Answered".

  | Kind     | Subject                                                 | Outcomes                                        |
  | -------- | ------------------------------------------------------- | ----------------------------------------------- |
  | approval | Its call                                                | accepted, declined, invalid, withdrawn, expired |
  | question | The asking call, or the task whose run asked            | accepted, withdrawn, expired                    |
  | sign-in  | The held turn, the task whose run asked, or a candidate | accepted, declined, failed, withdrawn, expired  |
  | budget   | The turn                                                | accepted, declined, withdrawn                   |

- **`withdrawn` carries a reason:** `turn-cancelled`, `superseded`, `superseded-by-message`, `owner-ended`, or `attempt-abandoned`.
- **Each sign-in attempt is its own interaction.** A newer attempt settles the older one `withdrawn: superseded`. A sign-in's subject is the turn, because the calls that asked leave the step and the model calls them again.
- **A step's approvals settle together.** Answers are revisable until every approval in the step has one (in HumanInput, the last answer wins), so no fact is published per answer. When the last answer arrives, every `interaction.settled` lands in one commit. A steering message from the turn's person withdraws the unanswered approvals (`superseded-by-message`), and answers already given stand.
- **`invalid` stays terminal**, as today. It's an answer naming an option the approval doesn't offer, and the call doesn't run.
- **No settlement by inference.** One commit carries `interaction.settled` (declined) and `call.settled` (rejected, `cause: {interactionId}`).
- **Candidates** are responders' answers to a policy-gated approval. They're public and carry the principal; Slack uses refused candidates to notify the responder privately. Only `interaction.settled` closes the interaction. A candidate settles one of these ways:
  - `accepted`, when its decision applied;
  - `refused`, by policy;
  - `failed`, when the responder's sign-in failed;
  - `expired`;
  - `withdrawn: superseded`, when the approval settled another way.
- **Relayed requests:** a request from a child session or workflow run has the parent's serving call as subject, and `origin: {sessionId, interactionId}` names the child's request. Relays chain hop by hop.
- **Sign-in challenge fields** (`url`, `userCode`, and the callback URL) carry over. Readers that shouldn't see them get them redacted in place ([Wire format](#wire-format)).

### Deliveries

```text
delivery.accepted  { deliveryId, principal?, source?: {channel, scheduleId?, caller?} }
delivery.consumed  { deliveryId, turnId, parts }     its message entered the conversation
delivery.finished  { deliveryId, outcome, turnId?, reason? }
```

- **What a delivery is.** It's the payload-level `deliveryId` minted per inbound operation (`channel/delivery-metadata.ts`): HTTP sends, channel webhooks, schedules (as the app principal), and parent-to-child messages.
- **No declared kind.** The facts that cite a delivery record what it did:

  | Effect                                      | Recorded as                                                                      |
  | ------------------------------------------- | -------------------------------------------------------------------------------- |
  | A message                                   | `delivery.consumed {turnId, parts}`                                              |
  | Context only (trusted notices in `context`) | `delivery.consumed {turnId, parts: []}`; the notice text stays private, as today |
  | Answers                                     | `interaction.settled {cause: {deliveryId}}`                                      |
  | A control                                   | That control's fact                                                              |
  | `outputSchema`                              | Private                                                                          |

- **Folded deliveries.** Deliveries admitted together each get their own `delivery.consumed` and `delivery.finished` (#3313).
- **Steering is visible at consumption.** A delivery steered into the open turn names that turn; a queued one is consumed by the next turn. Only the turn's principal, or its delegated caller, steers.
- **What resumes a paused turn.** Only a message from the turn's own person, or an answer. A context-only delivery never resumes a turn or withdraws its requests (#4276). It waits, is consumed when the turn next runs, and starts the next turn if the paused one is cancelled or cleared.
- **Controls become deliveries.** Cancel, clear, compact, and reset get an ID and carry the caller's auth, so `turn.settled {cancelled, cause}` names who cancelled.
- **Callbacks aren't deliveries.** Sign-in completions appear as causes: `{callback: {interactionId}}`.
- **Accepted means admitted.** The session admits deliveries at step boundaries, so `delivery.accepted` lands when the machine admits the delivery. HTTP's 202 with the `deliveryId` stays the transport acknowledgement. The queue is a selector: accepted deliveries not yet consumed.

**Finish rule.** A delivery finishes when the work it started or joined settles, or when the session can make no further progress on its behalf without another delivery.

| Outcome   | When                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `settled` | The work it started or joined settled. A steered delivery finishes with its turn; `turnId` points at `turn.settled.reply` |
| `paused`  | Further progress needs another delivery                                                                                   |
| `applied` | A control took effect                                                                                                     |
| `ignored` | The channel's `deliver` hook returned nothing                                                                             |
| `refused` | Not allowed, such as an unauthenticated answer to a policy-gated approval                                                 |
| `failed`  | Something went wrong                                                                                                      |

- **Answers join the work they resume.** An answer finishes `settled` when the resumed turn settles, or `paused` if it stops again. That formalizes `respond()`, which today ends "at its first turn boundary".
  - An answer that doesn't complete an approval batch finishes `paused` at once.
  - An answer to an interaction whose subject has no open turn finishes `applied`.
- **Pauses that don't finish a delivery.** A pause on tasks, or on a sign-in that completes through a callback, doesn't finish it, because the callback continues the same work. Readers that must return control at a sign-in (CLI `invoke`, the invocation API) stop on the open sign-in interaction.
- **Later, additively:**
  - `delivery.accepted.turnPolicy`, so a client can show "queued" up front;
  - `seenThrough: position`, so a message isn't taken as the answer to a prompt opened after it (#786).

### Turns and model runs

- **`turn.started { turnId, cause, follows }`.** `follows` is the turn whose context this one continues: the previous turn, or `null` after a clear ([Transcript and context](#transcript-and-context)).
- **`turn.paused { awaiting }`** references the interactions, calls, or tasks the turn waits on.
- **`turn.resumed { cause }`** is emitted where the machine leaves the pause, including when approved calls run before the next model call.
- **`turn.settled { outcome, reply?, cause? }`.** `reply` lists the parts that answer the turn: text and/or a structured result. Deliveries point at it through `delivery.finished.turnId`, so folded deliveries share one reply.
- **Model runs have IDs.** `stepIndex` and `sequence` disappear from payloads.
- **Model run outcomes:**
  - `completed`;
  - `failed`;
  - `interrupted`, for a cancel (later also steering or barge-in);
  - `abandoned`, when a retry superseded the run.

  `usage` is optional on every outcome, so cancelled runs report what they spent (#952).

- **Reissuing a model call.** A reissue that published nothing stays inside one run, as today for empty responses and dropped provider tools. Once anything was published, the run settles `abandoned` and the retry starts a new run.
- **Compaction** is a model run with `purpose: "compact"`. A compaction triggered by the token threshold records `trigger: {inputTokens}`; a manual compaction's cause is its control delivery. `context.compacted {runId}` carries no replaced range.

### Content

- **Content parts are model output only.** `kind` is open: text, reasoning, and structured results today.
  - A user message's parts ride on `delivery.consumed`, in eve's own schema: `{kind: "text", text} | {kind: "file", mediaType, filename?, size?, ref?}`.
  - The flattened `message` string goes away, and a `textOf(parts)` helper replaces it.
- **Announce, then introduce.** `content.delta` announces a part with its first delta, and `content.completed` introduces the part with its authoritative value.
- **Interrupted versus abandoned.**
  - **Interrupted:** a cancel (and later steering or barge-in) stops the output deliberately, and what was said stands. The step's cancellation path completes each in-flight part with what streamed, as `content.completed {interrupted: true}`, then sends `model.settled {interrupted}`. Today's client already keeps that text after a cancel, while removing tool cards whose input was still streaming.
  - **Abandoned:** a retry superseded the attempt, and a replacement follows. The run's terminal leaves its incomplete parts behind, and readers drop them.
  - Whether interrupted text enters the model's context is producer behavior. Today it doesn't, and that stays.
- **`phase` marks narration versus reply** on `content.completed`. `narration` is text followed by calls the turn continues with, including text in a step held for approvals; `reply` ended the run. Channels act on it as each part completes; `turn.settled.reply` is the final word.
- **Notices that aren't model output become delivery outcomes.** The "Authentication is required to respond to this approval." notice becomes `delivery.finished {refused, reason}`.

### Usage and failures

- **Usage:**
  - A session's own usage appears only on `model.settled`, including compaction runs.
  - Delegated usage appears only on an agent call's `call.settled`.
  - Totals are a selector. A parent counts a child's usage once.
- **Failures:** error details appear once, on the entity that failed. An owner that ends because of that failure references it: `turn.settled {failed, cause: {runId}}`, `session.closed {failed, cause: {turnId}}`.

### Child sessions and relays

- **`child.opened { sessionId, owner: {callId} | {taskId}, name, stream, remote? }`.** The parent stream contains only parent entities; the child's lifecycle lives in its own stream.
- **Hierarchical views come from a multi-stream fold.** The client's `AgentStreamFollower` already follows children with their own cursors; it becomes the documented fold, exposed as `children()` and `child(id)`. #666 asks for the opposite (forwarding child events into the parent stream); that would break the rule that a stream describes its own session. Server-side child views for channels (#2087, #3945) can come later as an additive selector.
- **`remote` is server-internal.** It holds `{url, resolverId}`: where a remote child runs, and the key of the authored credential functions. The parent's stream proxy needs it, and resolved headers are never stored.
  - It's present but not part of the public contract, and clients must not rely on it.
  - Today the proxy finds it by scanning the parent stream from line 0 on every follower connect, and every reader sees the remote URL.
  - It moves to a private side namespace per child if routes can read that across a session's successor runs (#4291). Answer forwarding already uses private records.
- **The relay protocol becomes its own contract.** Today parent and child exchange stream events:
  - the subagent adapter forwards child requests;
  - the remote callback route parses v26 event shapes strictly (`subagents/callback-route.ts`);
  - HumanInput's `relayed.authorization` input carries a `SubagentAuthorizationEvent`.

  These become relay messages keyed by the child's IDs, under a bumped remote agent protocol version, parsed non-strictly.

## Transcript and context

eve maintains two views, and the contract names both:

- **The transcript is what happened:** the stream, append-only and never rewritten. Readers render it.
- **The context is what the model sees next.** It stays private. Framework messages, the cancelled-call text, and compaction summaries live only there, while nested calls and interrupted text live only in the transcript.
- **Context facts never change an entity's lifecycle.** They describe changes to the context in transcript terms, at turn granularity. The contract promises nothing about which individual parts made it into history.

Turn lineage is the one piece of this that has to ship in v27:

- **`turn.started.follows`** is the previous turn, or `null` after a clear.
- **Readers render the conversation through the `conversation()` selector,** which walks `follows` back from the latest turn, never by line order.
- With that rule in place from the start, in-session edit, regenerate, and branch switching later become producer-only changes. Alternative replies become turns that follow the same turn, and version navigation falls out of grouping siblings.

What's deferred:

- **The fact that moves the context when no turn starts** (a rewind with nothing sent, or switching to an existing branch). It's added and named when the feature ships, for example `context.rewound`. It's additive, and a reader that ignores it catches up at the next turn's `follows`.
- **Forks into a new session (#75)** can add `session.started.forkedFrom {sessionId, turnId}`.
- **Rewinding past a compaction** needs the originals compaction discards today. Until a producer keeps raw history, such a request finishes `refused` with `reason: "context-unavailable"`.

## Example: a declined approval

Today, when a responder declines over HTTP:

```text
step.started       {turnId, sequence, stepIndex: 1}
actions.requested  {actions: [{callId: c1, kind: "tool-call", toolName: "deploy"}], …}
input.requested    {requests: [{kind: "tool-approval", action: {callId: c1}}], …}
step.completed     {finishReason: "tool-calls", usage, …}
turn.waiting       {on: "input", usage, …}
                   ── answer arrives; linked only through meta.deliveryIds ──
approval.settled   {outcome: "cancelled"}                ← means "declined"
input.resolved     {resolutions: [{outcome: "denied"}]}  ← settles c1 by inference
action.result      {status: "rejected", error, result}   ← a third word on c1's status
step.started       {stepIndex: 2}                        ← the only resume signal
```

Proposed, one line per commit or progress record (scopes omitted):

```text
0 facts     delivery.accepted   {deliveryId: d1, principal}
            turn.started        {turnId: t1, cause: {deliveryId: d1}, follows: null}
            delivery.consumed   {deliveryId: d1, turnId: t1, parts}
1 facts     model.started       {runId: r1, turnId: t1, purpose: "respond", modelId}
2 progress  call.input          {callId: c1, name: "deploy", delta: "{\"env\":\"prod\"}"}
3 facts     call.requested      {callId: c1, owner: {runId: r1}, capability: {kind: "tool", name: "deploy"}, input}
4 facts     model.settled       {runId: r1, outcome: "completed", finishReason: "tool-calls", usage}
5 facts     interaction.opened  {interactionId: i1, subject: {callId: c1}, request: {kind: "approval", prompt, options}}
            turn.paused         {turnId: t1, awaiting: [{interactionId: i1}]}
            delivery.finished   {deliveryId: d1, outcome: "paused", turnId: t1}
            ── answer ──
6 facts     delivery.accepted   {deliveryId: d2, principal}
            interaction.settled {interactionId: i1, outcome: "declined", cause: {deliveryId: d2}}
            call.settled        {callId: c1, outcome: "rejected", cause: {interactionId: i1}}
            turn.resumed        {turnId: t1, cause: {deliveryId: d2}}
7 facts     model.started       {runId: r2, turnId: t1, purpose: "respond", modelId}
```

## Writers, retries, and recovery

The contract states what the stream says when its writer fails, and what observers can rely on.

**Retries happen at two levels.**

- **Inside a step:** up to three model-call attempts on transient provider errors.
  - If the failed attempt published nothing, the retry stays in the same run.
  - Otherwise the run settles `abandoned`, calls settle by what actually happened, and a new run starts. That fixes #3308's ghost tool cards.
- **The whole step:** Workflow re-runs it from its checkpoint, and the retry catches up.
  - **The checkpoint records its stream position,** as of the end of the previous step.
  - **On `attempt > 1`, the step folds from that position to the tail** before deciding anything.
  - **It skips facts already present that are fully determined by its inputs:** accepts, consumes, turn starts.
  - **It closes whatever the dead attempt left open:** runs settle `abandoned`; calls settle `interrupted: attempt-abandoned`; interactions settle `withdrawn: attempt-abandoned`. This fixes a bug on `main` where an approval card published by a dead attempt stays open forever.
  - **Runs the dead attempt completed,** whose private results are lost, get called again. `turn.settled.reply` still points at the right reply. A `context.discarded {runIds}` annotation can mark the lost run later, additively. A private journal of run and tool results, following `authorization-completion.ts`, could later let retries reuse them instead, which would also prevent duplicate tool side effects.

**Attempts are assumed to run one after another.**

- The ownership lease (860 s) outlives the maximum function duration (800 s), and optimistic inline start is off by default.
- Self-hosted multi-instance worlds, `WORKFLOW_OPTIMISTIC_INLINE_START`, and Vercel's 30-minute duration beta break the assumption.

**The fold's tolerance rules are part of the contract,** so every reader agrees when something gets through anyway:

- the first terminal wins;
- after an owner's terminal, any child left open reads as abandoned, and later facts that reference that owner are dropped;
- nothing after `session.closed` counts;
- progress for unknown or closed entities is dropped;
- the checker flags every one of these in tests.

**Facts are durable before anything acts on them.**

- Order per commit: write, drain, deliver to channels, then run hooks. Today channel effects run before the write, and Workflow 5's `write()` resolves on buffer.
- Progress goes to channels live, but only when no fact is pending, so order is kept.
- Adapters no longer shape written facts. The only shaping today is the continuation token on `session.waiting`, which v27 removes.
- **Observers get each fact at least once, in order, across crashes,** with `ctx.position` (line plus index) for deduping.
- **Costs:** a small extra latency on facts, less batching, and rare duplicate posts after a crash, because recovered facts are re-delivered. A missed approval card is worse than a duplicate.

**Zombie writers need fencing from the platform.** In #2599 a redelivered step left the original running. It appended about 987 deltas over roughly 10 minutes, then failure events for a turn the retry had completed. Here's what zombies break and what fixes it:

| What breaks                                                                                       | Fixed by                                                                                        |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Stream pollution**                                                                              | Mostly the tolerance rules. The gap is new entities introduced under an owner that's still open |
| **Duplicate side effects in the zombie's process:** channel posts, relays, hooks, tool executions | A lost-ownership signal that aborts the old attempt                                             |
| **Shared resources:** sandbox races, orphaned children, hooks resumed twice                       | The same signal                                                                                 |
| **Cost:** provider tokens, invocation time, noisy traces                                          | The same signal                                                                                 |

Fenced appends would fix stream pollution entirely. Combined with durable-before-effects, a fenced zombie couldn't post or run hooks at all. Both asks belong with vercel/workflow#3811. Workflow's write sessions carry a `chunkSeq`, but it's local to one writer's lifetime.

**The outside world isn't repaired.** Side effects of inline tools that already ran aren't undone.

## Evolution rules

Streams continue across deployments (idle handoff), and clients may be older or newer than the server. Within a major version, new readers must read old lines and old readers must read new ones.

**Versioning.** One major version plus additive minors:

- clients accept any minor and refuse unknown majors;
- sessions don't cross a major;
- a minor number may appear in a header, for diagnostics only.
- **No per-type versions.** An old reader can't safely ignore a lifecycle fact it doesn't understand, so a lifecycle type's version bump is a major in disguise. Annotations and progress evolve by adding new types.

**Rules every reader follows, including server relays:**

- ignore unknown fields;
- ignore unknown fact types;
- ignore unknown progress types;
- map unknown values of open enums to the declared fallback;
- never use strict objects or closed enums on cross-version paths. The remote callback route does today, and must change.

**The extension rule.** New fact types may introduce new families or annotate existing entities. They may never change an entity's open/closed status, its ownership, or the meaning of existing facts. A reader that ignores them keeps a coarser lifecycle, never a wrong one.

**Closed and open sets.**

- **Closed:** terminal outcome sets ([Event catalog](#event-catalog)).
- **Open, each with a fallback:**

  | Open set                                                                           | Fallback                                              |
  | ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
  | Content `kind`                                                                     | A generic block, using `mediaType` and `fallbackText` |
  | Capability `kind`                                                                  | A generic call card, using `name`                     |
  | Interaction `kind`                                                                 | A generic prompt, using the common request fields     |
  | `phase`                                                                            | Narration                                             |
  | Cause kind                                                                         | "System"                                              |
  | Delivery source kind, model `purpose`, `finishReason`, error codes, every `reason` | Open strings                                          |

**One word, one meaning:**

| Word        | Meaning                                             | Used by                              |
| ----------- | --------------------------------------------------- | ------------------------------------ |
| accepted    | The answer was taken                                | interaction, candidate               |
| declined    | A person said no                                    | interaction                          |
| refused     | Policy said no                                      | candidate, delivery                  |
| invalid     | The answer didn't fit the request                   | interaction                          |
| withdrawn   | The asker stopped waiting; `reason` says why        | interaction, candidate               |
| expired     | Time ran out                                        | interaction, candidate               |
| failed      | Something went wrong                                | every family                         |
| completed   | Finished normally                                   | session, turn, model run, call, task |
| cancelled   | Someone stopped it directly                         | turn, task                           |
| interrupted | Cut off because something it depends on stopped     | model run, call, content             |
| rejected    | Never ran because of a decision; `cause` says whose | call                                 |
| abandoned   | Superseded by a retry                               | model run                            |

**Values by reference.**

- Fields that may be large or binary are typed "inline value or reference" from day one: delivery file parts, content parts, call input and output. A reference is `{ref, mediaType?, size?, preview?}`.
- Bytes never go inline on the stream. Today raw MCP media results and client `data:` URLs put bytes on it, while history already stores content-addressed refs.
- Producers may keep inlining everything else for now, so moving large outputs to references later is a minor change. A session-scoped route to fetch references comes later.

**Enforcement, to start:**

- a protocol capability in `extension-contracts`, whose classifier passes additive changes and flags breaking ones (a removed field, a newly required field, a value added to a closed set, a removed type). It covers the public projection tables too;
- an old-reader conformance test: the v27.0 fold over golden scenario streams from the current producer;
- the checker in tests.

## Session projection

Proposed public tables, one per family, at a position:

```text
SessionProjection @ position
├─ session        status: open | completed | failed · parent?
├─ deliveries     [deliveryId]     principal? · source? · status: accepted | consumed | finished
│                                  turnId? · outcome?
├─ turns          [turnId]         cause · follows · status: active | paused | completed | failed | cancelled
│                                  awaiting? · reply?
├─ runs           [runId]          turnId · purpose · modelId · status · finishReason? · usage?
├─ parts          [partId]         runId · kind · phase? · interrupted? · status
├─ calls          [callId]         owner · capability · taskId? · status: open | settled · outcome?
├─ tasks          [taskId]         startedBy · kind · name · status: running | ended · outcome?
├─ interactions   [interactionId]  kind · subject · origin? · status: open | settled · outcome? · cause?
│                                  candidates[candidateId] { principal · outcome? }
└─ children       [sessionId]      owner · name · stream
```

- **The tables are public, read-only, and typed.** Fields are what the facts introduce and settle, plus status. They follow the same stability rules as the wire.
- **Internal bookkeeping stays out of the public types:** indexes, pruning marks, `outputStarted` (moved to private state, because it derives from progress), and the client-only overlay that marks an approval answered before the server confirms.
- **Selectors are the recommended way to read, not the only one.** They encode joins, fallbacks for open kinds, and common questions; anyone can read the tables and write their own. The starting set:
  - turns and conversation: `turn`, `activeTurn`, `conversation` (the branch path), `reply`, `failure`;
  - entities: `call`, `task`, `tasks`, `interaction`, `openInteractions({kind?, subject?})`;
  - deliveries: `delivery`, `queue`;
  - session: `idle`, `usage`, `children`, `child`, `childForCall`.

  The list comes from an audit of what the TUI and the web chat read today.

- **Adding state without rebuilding the reducer.** Today extending the built-in state means wrapping `conversationReducer` by hand, with the projection hidden behind a symbol. Instead:

  ```ts
  const reducer = extendConversation({
    initial: () => ({ deploys: 0 }),
    reduce(extra, fact, view) {
      return fact.type === "call.settled" &&
        view.calls[fact.data.callId]?.capability.name === "deploy"
        ? { deploys: extra.deploys + 1 }
        : extra;
    },
  });
  useEveAgent({ reducer });
  ```

- **Retention.** The client keeps everything it has folded for a session it has loaded. Server views prune settled entities that nothing references, following each family's declared owner links.
- **No projection snapshots over the wire.** The wire contract stays facts only, and catch-up skipping keeps loads cheap. Server readers fold from line 0 with catch-up skipping, because the stream contract is stable across deployments while a saved projection's internal shape isn't. That replaces three ad hoc scans:
  - the remote binding lookup;
  - Telegram's sign-in callback, which takes the latest `authorization.required` without checking whether it completed;
  - the invocation API's 64-event window, which a long reply's deltas can push an open request out of.

## Authoring API impact

| Surface                                    | Today                                                                           | Proposed                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `defineHook({ events })`, channel `events` | v26 names; hooks get the event, channels get `(data, channel, ctx)`             | Catalog names, including progress types; every handler gets `(data, ctx)`; `*` gets `(fact, ctx)` |
| Channel `session.waiting` handlers         | Authorable on most channels; the adapter rewrites `continuationToken`           | An adapter `idle` callback, fired when a commit leaves the session idle                           |
| `defineDynamic({ events })`                | `session.started`, `turn.started`, `step.started`                               | Resolution points keep their names, except `step.started` becomes `model.started`                 |
| Memory providers                           | `recall`/`capture` keyed by `turn.started`, `compaction.*`, `turn.completed`    | Phase names unchanged; invoked at the same transitions                                            |
| Instrumentation providers                  | Their own vocabulary (`step.attempt.*`, `channel.delivery.*`, …)                | Unchanged; only the bridge from facts changes                                                     |
| Evals                                      | `turn.event()` with v26 names; `calledTool` and `noFailedActions` read receipts | Catalog names; outcomes from `call.settled`; run facts from selectors                             |
| `ClientSession.send()`, `respond()`        | Inferred from segment boundaries                                                | Read until `delivery.finished`; the reply from `turn.settled.reply`                               |
| `ConversationState`                        | Public tables mixed with the UI view model                                      | The UI view model, public v27 tables, selectors, and `extendConversation`                         |

**What handlers get in `ctx`:**

| Field      | What it is                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `session`  | `{id, auth, parent}`, plus `continuation` for channels                                           |
| `scope`    | `{turnId?, taskId?, runId?}`. `ctx.session.turn {id, sequence}` goes away                        |
| `position` | The line plus the index within it                                                                |
| `view`     | The public tables and selectors as of this whole commit. Progress handlers see the latest commit |
| `channel`  | The channel's state and operations (channels only)                                               |
| `cancel()` | Hooks only                                                                                       |

- **The argument shape is effectively permanent.** Authored code compiles against it, so new things go into `ctx`, which can grow additively. That includes a possible `ctx.fact`, or `ctx.viewBefore` (the view as of the previous commit).
- **`ctx.view` reflects the whole commit.** A commit is one transition, so a handler for `interaction.settled` sees the call already settled when the same commit settles it. Handlers read _what changed_ from `data` and _where things stand_ from `ctx.view`.

**Participants versus observers.**

- **Participants.** Dynamic resolvers and memory providers are participants. The machine invokes them at transition points, before or as it decides, and records what they return so a restore doesn't re-resolve against today's configuration. Their keys name resolution points that happen to share names with facts, so their extension epochs survive.
- **Observers.** Hooks and channel handlers observe durable facts, in order, at least once. They can't change a commit, and their errors are logged. `ctx.cancel()` queues a control input for the next boundary, so the turn settles with `cause: {hook}`. Progress handlers get the weaker progress guarantees.

## Private state

Withheld model responses, prepared inputs, answer routes, grants, sign-in resume data, execution plans, history, checkpoint positions, and `outputStarted` stay private. Lifecycle authority remains in the projection; these records supply execution payloads and handles, not a second lifecycle model.

The contract does not require replacing private snapshots with an appended journal; that needs separate measurements.

## Compatibility

The break supports as little as possible, following HumanInput's precedent of not migrating parked requests:

- **No upcaster.** Clients read v27 only, and the v21–v26 normalization is deleted. The CLI, ACP, and eval runners report the existing unsupported-version error against older deployments.
- **Sessions don't cross the break.** Pre-break checkpoints are incompatible, so the deployment that owns a session keeps it until it ends ([`single-workflow-session-upgrades.md`](./single-workflow-session-upgrades.md)). Self-hosted services drain, or their channels start fresh sessions.
- **Pre-break history isn't readable by v27 clients.** If a product needs it, a read-only upcaster can go into the stream route later without touching anything else.
- **No aliases for hook and channel event names.** Their retained extension epochs are dropped with a reason: 38 channel fixtures and 31 hook fixtures. Epochs for dynamic resolvers, memory, and instrumentation are unaffected.
- **The remote agent protocol version is bumped.** A v27 parent calling a v26 remote agent fails at call time with the existing mismatch error.
- **Two removals become possible, though not required:**
  - the one-time legacy session import;
  - remote agent protocol 1.
- **After the break,** compatibility follows [Evolution rules](#evolution-rules), with no version bump for additive changes.

## Pressure test

An analytical pressure test covered 29 roadmap scenarios; it was not an implementation test.

- **Additive features:** steering (#867, #3313, #1287), prompt-aware answers (#786), multi-hop relays (#4088), deadlines (#3546), model fallback, principal-scoped sessions (#661), new interaction kinds, memory recall, structured task output (#3200), schedules, plans (#544), and media references (#3384).
- **Required now:** turn lineage for edit/regenerate/fork (#75), interrupted output with usage (#952), complete outcome sets, tolerant readers, retry recovery (#2599, #3308), separate child streams, and public projection tables. These decisions are incorporated above.
- **Out of scope:** realtime media transport (#637); the stream records its transcript, with media out of band.

## Implementation estimate

This comes from reading the codepaths on `main` at `a07299af2`, not from a prototype. The deltas are rough, to within a few hundred lines per row.

| Area                          | Today                                                                                                                  | Change                                                                                      | Net    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| Contract                      | `message.ts` 2,006 lines (types ~930; builders ~960, of which ~200 project user content) plus `message-version.ts` 258 | Zod schemas for 27 types; line codec; user-part projection kept; per-event builders removed | −1,100 |
| Emitters                      | 86 builder calls in 25 files; ~140 coordinate lines; emission-state counters                                           | Coordinates removed; scope stamped and run and part IDs minted centrally                    | −100   |
| Publisher                     | `publish-session-events.ts` 490, `ordered-stream-emitter.ts` 278                                                       | A commit written as one line; drain before effects; progress ordering                       | +170   |
| Stream route                  | `serializeAsNdjson`, lease records                                                                                     | Catch-up skipping with in-order holdback; position record                                   | +150   |
| Deliveries                    | `TurnDeliveryIdsKey` plus stamping                                                                                     | Three facts, finish rule, `ignored` and `refused`, controls carry an ID and auth            | +350   |
| Retries                       | —                                                                                                                      | Checkpoint position, catch-up, abandonment, in-step retry closure                           | +300   |
| Closure, tasks, turns         | Cancel paths write history-only repair                                                                                 | Repair published; interrupted parts; `turn.resumed`, `task.ended`, `call.delegated`         | +180   |
| Server fold                   | Stack's `session-projection.ts`, 663 lines                                                                             | Families for deliveries, runs, parts, children; tolerance rules; generic pruning; checker   | +200   |
| Server stream scans           | Remote binding, Telegram, invocation window (~230)                                                                     | Shared-fold readers                                                                         | −130   |
| Relay protocol                | Subagent adapter and callback-route schemas (~350)                                                                     | Its own relay messages, parsed non-strictly                                                 | ~0     |
| Client reducers               | Message reducer family ~1,320; conversation reducer 288                                                                | Keyed by run, part, and call IDs; public tables; selectors; `extendConversation`            | −250   |
| Client response boundaries    | `TurnSegment`, summaries, delivery-ID filtering (~300); multi-version parsing                                          | `delivery.finished` and `turn.settled.reply`; v27 only                                      | −270   |
| Evals, TUI, `invoke`, ACP     | `derive-run-facts.ts` 263, TUI reducer, ACP adapter 562                                                                | Selectors and renames                                                                       | −140   |
| Channels                      | 82 handlers in 14 files; task cards 470; definitions 464                                                               | Renames; `(data, ctx)`; no receipt special case; `phase`; idle callback                     | −110   |
| Participants, instrumentation | `native-events.ts` bridge 381; memory and dynamic dispatch                                                             | Facts mapped to unchanged vocabularies                                                      | +30    |

**Totals:**

- **Source:** about −700 lines net, out of roughly 10,000 touched; the plausible range is −200 to −1,500. The deletions are inference code and coordinate plumbing. The additions are deliveries, recovery, catch-up reads, and commit ordering: new guarantees rather than reshuffled code.
- **Enabled by the compatibility cut, beyond that:**
  - dropped channel and hook fixtures (−822);
  - the legacy session import (−595);
  - remote agent protocol 1 (−172).
- **Tests:** 382 test files reference event types (~2,970 references, 642 builder calls). This is the largest churn, about 6,000–10,000 lines touched, roughly flat in net.
- **Docs:** 60 docs pages reference event names (352 references).

Lifecycle lines per turn, not counting progress:

| Scenario                                  | v26 events | Proposed facts | Difference                                                               |
| ----------------------------------------- | ---------- | -------------- | ------------------------------------------------------------------------ |
| Message, text reply                       | 7          | 8              | `delivery.accepted`                                                      |
| Message, three parallel tool calls, reply | 15         | 16             | `delivery.accepted`                                                      |
| Approval round trip                       | 14         | 18             | Two `delivery.accepted`, a `delivery.finished` per pause, `turn.resumed` |
| Ten parallel tool calls                   | 20         | 20             | `call.requested` and `call.settled` replace today's pair                 |

Facts group into fewer lines, because one commit is one line. Progress dominates line counts either way, and catch-up skipping removes it from reloads.

## Rollout

**Before the break,** each step can land on v26 and makes the break smaller:

1. **The contract module itself:**
   - schemas, catalog, and checker;
   - the v27 fold, tables, and selectors;
   - golden scenario streams.

   Nothing in the runtime uses it yet, and HumanInput doesn't touch `protocol/`.

2. **Server readers move onto the shared fold,** and turn identity comes from the projection.
3. **After HumanInput merges:**
   - its lifecycle state moves into the projection;
   - every session input goes through one commit path;
   - one suspension shape, which maps onto `turn.paused {awaiting}`;
   - one run registry for delegated work.

**The break** is one stream-version change, developed as a stack and released together:

1. Line format, positions, catch-up reads, and scope. Readers that count lines are fixed.
2. IDs and ownership: run and part IDs, owners at introduction, checkpoint positions, catch-up, abandonment, tolerance rules.
3. Calls and tasks.
4. Interactions, behind `hitl/` and coordinated with HumanInput.
5. Deliveries, controls with auth, `turn.settled.reply`, `follows`.
6. Content: `phase`, interrupted parts, user parts on `delivery.consumed`.
7. Durable-before-effects ordering, and handlers with `(data, ctx)`.
8. The relay contract and the remote agent protocol bump.
9. Readers: client tables and selectors, channels, evals, ACP, the TUI, and the invocation API. The v21–v26 normalization and the dropped epochs are deleted.

## Non-goals

- A generic `entity.updated` or patch event.
- Self-contained events beyond the fixed `scope`; a position plus the fold replaces them.
- Publishing private records to make state reconstructible.
- A declarative state-machine language.
- Claiming multi-record atomicity that storage doesn't provide; a commit is atomic because it is one chunk.
- Projection snapshots on the wire.
- Per-type event versions.
- Unifying HITL execution or authorization just because the lifecycle is unified.

## Open questions

1. **Can routes read a side stream namespace across a session's successor runs (#4291)?** The answer decides where the remote binding lives.
2. **When will Workflow provide a lost-ownership signal and fenced appends** (vercel/workflow#3811)?
3. **What coalescing window, if any?** That depends on measuring lines per reply under Workflow 5.
4. **Does any product need pre-break history?** It could be served later through a read-only upcaster.
5. **What does stream cost look like on a scenario harness?** The counts above are analytical.
6. **Which readers should get sign-in challenge fields?** Redaction in place makes either answer possible.
7. **When rewind or branch switching ships:** what should the standalone context fact be called, and should producers keep raw history across compaction?
8. **When should `context.discarded` arrive** for completed runs lost to recovery? It's additive whenever it does.
