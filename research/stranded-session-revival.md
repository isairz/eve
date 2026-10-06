---
issue: https://github.com/vercel/eve/issues/3022
status: in-progress
last_updated: "2026-10-05"
---

# Sessions across eve upgrades

## Summary

A session is **stranded** when the code that started its Workflow run is no longer available to
execute it. On Vercel this is rare: old deployments keep running, and sessions hand off to the new
one. On self-hosted Worlds, every eve upgrade strands every parked session (#2866, #3022).

This doc proposes two tracks. They are independent, can be built in parallel, and can ship in
either order:

| Track                                                                                            | What it does                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [1. Deployment routing for self-hosted Postgres](#1-deployment-routing-for-self-hosted-postgres) | Old and new builds run side by side against one Postgres World, and each run's work goes to the build that started it. Sessions hand off as they do on Vercel, so fewer sessions strand.                                                                   |
| [2. Lazy reset and replacement](#2-lazy-reset-and-replacement-of-stranded-sessions)              | When a session strands anyway, eve preserves it without running it. The next channel message retires it and starts a replacement session, optionally carrying the old transcript. Sessions that never get another message are cleaned up at their timeout. |

Routing reduces how often sessions strand, on Postgres only. Lazy replacement defines what happens
when they do, on every World, including the default local World where routing is
[deferred](#deferred-local-world). Neither depends on the other: routing changes only _which_
owners count as retired, and replacement handles them the same way.

An earlier version of this doc also proposed reviving stranded sessions from their Workflow
checkpoints. That option is dropped; see [Considered and rejected](#considered-and-rejected).

## Status quo

**Replay needs the original code.** A Workflow run can only be replayed by the exact code that
started it. eve's step ids include the eve version, so after any eve upgrade, older runs can't be
replayed. Authored step ids are unversioned, so an app release without an eve upgrade replays
cleanly.

**Vercel hands sessions off.** Ingress stamps each delivery with the deployment that accepted it.
When a delivery from a newer deployment reaches an idle session, the old owner, still running on its
old deployment, checkpoints itself and starts a successor on the new deployment
([handoff](./single-workflow-session-upgrades.md)). The session id and stream don't change. The
original run parks as the **anchor** until the session ends, keeping the stream open. This works
only because Vercel keeps old deployments running and routes each run to its own deployment.

**Sessions end on a timeout.** A session ends when `sessionTimeoutMs` has passed since it was
created or last handed off. The default is 30 days, and `false` turns the timeout off. Ordinary
messages don't extend it. The deadline is enforced by a timer workflow that signals the session,
which then runs its own finalization and releases its continuation aliases. A later post in that
Slack thread starts a fresh session with no memory of the old one.

**Self-hosted Worlds can't hand off.** The World is chosen when the app is built
(`experimental.workflow.world`, otherwise the local World), and `eve start` runs that one build.
world-local and world-postgres both have a single queue target and a fixed deployment id, so
neither routes runs by deployment. When an operator upgrades eve:

- **Startup.** The World re-enqueues every active run. Each parked session replays on the new code
  and fails with `CORRUPTED_EVENT_LOG`, an error that suggests storage corruption rather than an
  upgrade.
- **Slack user (and any channel alias).** The next message silently starts an empty session, so the
  bot forgets the conversation. A turn that was in progress during the upgrade never gets a reply.
- **HTTP and TUI clients that hold a session id** get `session_not_active`, with no reason.
- **Descendant runs** (tasks, subagents, workflow tools) are orphaned until their own timeouts.

`eve dev` has the same problem across eve upgrades, because every build generation runs the
installed eve.

## Recommendation

Pursue both tracks in parallel:

- **[Deployment routing for self-hosted Postgres](#1-deployment-routing-for-self-hosted-postgres)**,
  so that self-hosted eve has a supported way to run several deployments, on Postgres. Today it has
  none.
- **[Lazy reset and replacement](#2-lazy-reset-and-replacement-of-stranded-sessions)**, so that when
  sessions do strand, the user keeps the conversation's context, callers get precise errors,
  operators get accurate logs, and stranded runs and their descendants are cleaned up. Ship it first
  with no carried context, then add the bounded transcript and make it the default.

A custom hook that fetches or summarizes the previous conversation is a
[possible later API](#custom-context-hook), once the default and the replacement metadata ship.

## 1. Deployment routing for self-hosted Postgres

Today no self-hosted World keeps a session working across a deployment. Every upgrade ends every
parked conversation, and the only workaround is to avoid upgrading while sessions are open. Routing
would give Postgres the same stability across deployments that Vercel has, as a supported upgrade
path. The default local World would still not have it: an eve upgrade there strands sessions
exactly as it does today, and lazy replacement handles them (see
[Deferred: local World](#deferred-local-world)).

A self-hosted World that does what Vercel does gets handoff without changes to eve's session code:

| Requirement                                                                                  | Postgres today                                                           |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Identity.** Each run records the build that started it, and each build has a different id. | Every run records `"postgres"`                                           |
| **Routing.** Every delivery for a run reaches that run's build.                              | One graphile-worker task, `workflow_flows`. Any process claims any job   |
| **Old builds stay executable** until their runs end.                                         | Possible. Workers pull from the database, so they need no public traffic |
| **Shared storage across versions.**                                                          | One schema, written by several client versions                           |
| **Liveness.** eve can tell whether a build has been decommissioned.                          | None. A job for a stopped build waits forever                            |

Workflow core already does its part. `resumeHook`, step dispatch, and cross-deployment `start()` all
pass the run's `deploymentId` to `world.queue()`, and world-postgres ignores it. Core's
deployment-affinity guard, which reroutes a misrouted delivery, turns on when the World declares
`capabilities.deploymentAffinity: true`.

### Upgrade lifecycle

1. The operator deploys build B and points all public traffic at it.
2. Build A keeps running as a **worker-only** process (`eve start --worker-only`). It claims only
   jobs for build A and delivers them to its own loopback port.
3. New sessions start on B. A message to an old session also lands on B. B resumes the session's
   hook, and the World routes the wake to A. An idle session hands off to B. A busy one finishes its
   work on A, and a later message moves it.
4. The operator decides how long A's workers stay up, based on their session timeout settings. A
   session's anchor stays on the build that created it until the session ends, and each handoff
   restarts the timeout. Managing this is manual. When the operator decommissions A, its remaining
   sessions are stranded, and B [replaces](#2-lazy-reset-and-replacement-of-stranded-sessions) them
   lazily.

No session-aware router is needed: public traffic always goes to the newest build. Scheduled tasks
and channels that pull input must run only on the newest build, so worker-only mode turns them off.

### Changes

**Workflow (`@workflow/world-postgres`, `@workflow/world`):**

- `getDeploymentId()` returns a configured build id, for example from a standard
  `WORKFLOW_DEPLOYMENT_ID` variable.
- `queue()` targets `opts.deploymentId ?? self` through task identifiers such as
  `workflow_flows@<buildId>`. Each process registers only its own build's tasks. Startup recovery
  re-enqueues only its own build's runs.
- Declare `deploymentAffinity`.
- A build registry (heartbeats, spec version, decommissioned flag) behind a new optional World API.
- **Mixed-version storage.** Schema migrations stay expand-only until the oldest live build is
  decommissioned, and old clients tolerate rows written by newer ones. This is the hardest part,
  and it becomes a permanent rule for world-postgres releases.

**eve:**

- `eve build` derives a build id and injects it before the World is constructed.
- `eve start --worker-only`.
- Build outputs that aren't overwritten. Container images already work. Plain hosts need
  `.eve/builds/<id>` or similar.
- Retirement evidence based on decommissioning instead of eve-version mismatch (see
  [Retired versus unavailable](#retired-versus-unavailable-owners)). A build whose workers are only
  temporarily down is not retired, because retirement can't be undone.
- Commands to list and decommission builds, and an upgrade guide.

Runs created before routing ships record `"postgres"`. They strand once, on the first upgrade after
routing ships, and are replaced lazily.

## 2. Lazy reset and replacement of stranded sessions

Some sessions strand even with routing: on the local World and single-build setups, and on Postgres
when a build is decommissioned. eve should detect this before delivering a message, rather than let
replay fail, and should keep the conversation going on the new code.

The proposal is **lazy**: eve does nothing to a stranded session until something touches it. At
startup it skips the stranded run instead of replaying it, and leaves its hooks in place, so the
channel address still points at the old session. Then one of three things happens:

```text
Confirmed retired owner → skip replay; keep hooks; refuse new work to the old run
  ├─ channel message before the cutoff
  │    → capture bounded transcript (optional) → retire old run
  │    → start one replacement session → process the message as its first turn
  ├─ explicit reset → retire, no replacement, no carried context
  └─ cutoff reached with no message → cleanup retires the run and its descendants,
                                      releases its hooks, starts no replacement
```

The **cutoff** is the session's lifetime start plus 30 days: its creation or latest deployment
handoff, the same anchor as the default `sessionTimeoutMs`. A session stranded right after a handoff
gets the lifetime it would have had healthy. After the cutoff, the next message starts an ordinary
fresh session with no link to the old one.

### Retired versus unavailable owners

Replacement is irreversible, so eve acts only on owners it can prove are permanently gone. Owner
inspection returns one of three verdicts:

- **`runnable`.** Deliver normally.
- **`retired`.** The owner's code is gone for good. Without routing, this means the run's eve
  version differs from the running one, and only under an explicit single-build retirement policy
  (the local World and `eve dev`). With routing, it means the owner's build was decommissioned.
- **`unavailable`.** eve can't run the owner now but has no proof it is gone, for example a dormant
  `eve dev` generation or a build whose workers are down. Deliveries are refused with a retryable
  error. Nothing is ended.

Ingress, the startup replay guard, and cleanup share this one verdict, so a run the guard skips is
always refused at ingress. Vercel (`deploymentAffinity`) is not checked at all.

### Replacement with and without a carried transcript

When a channel message reaches a retired owner before the cutoff, eve retires the old session (owner
and stream anchor), starts a new session at the same address, and runs the message as its first
turn. The new session has a new id and stream, and initializes normally from the incoming request,
with fresh auth and channel binding. Concurrent messages to the address converge on one replacement.

What the replacement knows about the old conversation is set by one option:

```ts
// Proposed defineAgent option fragment; names are provisional.
sessions: {
  replacement: { context: "transcript" }, // or "none"
}
```

- **`"none"`.** The replacement starts empty, like a session after a timeout. This is the first
  milestone and its initial default: it fixes the misleading errors, the dropped in-flight turn, and
  the orphaned runs, without changing what the model sees.
- **`"transcript"`.** eve reads the tail of the old session's public stream and gives the new
  session the recent user and assistant text as labeled historical context, ahead of channel
  context and the new message. This becomes the default once its limits and tests are settled.

Either way, the replacement learns where it came from, on `ctx.session.replacement` and
`session.started.data.replacement`:

```ts
{
  previousSessionId: "wrun_…",
  cause: "deployment-retired",
  context: "transcript", // or "none" / "unavailable"
}
```

Channels can use it to tell the user the agent was upgraded. Authored hooks can record the link.
Replacements after the cutoff, and fresh sessions after cleanup, carry no metadata.

### The carried transcript

**Source.** The public event stream already records the conversation: `message.received` for user
messages and `message.completed` for assistant replies. It is eve's own versioned protocol, which
clients already read across eve versions, so the new build reads it from storage without running
old code. Workflow step inputs, which revive would have used, are internal and change with
`DURABLE_SESSION_VERSION`.

**Bounds.** The read is bounded before parsing: at most 2,000 tail events and 4 MiB within
5 seconds. The projection keeps at most 40 messages, 24,000 code points, and an estimated 8,000
model tokens, cutting the oldest message from its front. Reasoning, tool calls and results,
attachments, approvals, and partial output are excluded.

**Boundaries.** Text before the last `context.cleared` or reset is not carried. A predecessor with
zero retention carries nothing; eve does not keep a separate recovery copy that would defeat the
retention setting. A read that fails or can't reach the tail within its bounds reports
`context: "unavailable"` and logs a warning; it never fails the replacement.

**Successive replacements.** The structured transcript is published once on the replacement's
`session.started`. If that session later strands too, its capture starts from that copy, so the
carried text stays bounded without walking an unbounded predecessor chain.

**What it isn't.** The transcript is text, not restored execution. History, authored state, limits,
usage, credentials, and the sandbox all start fresh. Work in progress on the old run is lost and
never retried. If the old agent said "I've started the deployment check," the new session must not
treat that as evidence it finished. Old approvals authorize nothing: an input response addressed to
the stranded session is rejected, with or without an accompanying message, and the model has to ask
again.

Channels can still add their own context on top. Slack's `threadContext`, for example, can include
thread messages the bot never received. It isn't a framework-wide substitute: it is capped at the
first 50 thread messages, needs Slack history permissions, and other channels may have no history
API.

### Custom context hook

Some apps already keep their own conversation store or summaries, or want a model-written summary
instead of a raw tail. A later API could let an app supply the carried context itself:

```ts
// Proposed defineAgent option fragment; not a supported API.
sessions: {
  replacement: {
    async prepareContext({ previous, transcript, signal }) {
      const summary = await loadConversationSummary(previous.sessionId, { signal });
      return summary ? [summary] : transcript ? [transcript] : [];
    },
  },
}
```

`loadConversationSummary` is app code. It could read the app's own store, call `sessions.attach()`
with `follow: false` for a bounded read of the old stream, or summarize eve's default transcript
with a model. eve calls the hook on the new code after the old session is retired and before the
replacement starts. It passes safe, versioned metadata (`previous.sessionId`, cause, lifetime start)
and the bounded default transcript, not the old session's `HookContext` or state. What the hook
returns is carried in place of the default transcript.

Before exposing it, the contract needs:

- **A timeout and fallback.** The hook runs in channel ingress. On timeout or error, eve falls back
  to the default transcript or to no context, and reports `"unavailable"`.
- **Retries.** The hook may run more than once for one replacement if the sender retries after a
  partial failure, so it must be idempotent.
- **Output bounds.** eve caps what the hook returns with the same model-token budget as the
  default.
- **No lifecycle control.** The hook prepares context only. eve owns retirement, arbitration, and
  cleanup; the hook can't start, cancel, or keep sessions.
- **Boundaries.** The hook isn't called after the cutoff or after an explicit reset. Apps that read
  their own store must respect `context.cleared` and retention themselves.

Defer the hook until the default and the replacement metadata ship. `context: "none"` plus the
metadata already lets an app look up its own history from `session.started`, at the cost of
loading it after the first turn starts rather than before.

### What users see

| Who                                     | Today                                                            | With lazy replacement                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack user (any channel alias)          | The bot answers with no memory of the thread                     | Before the cutoff, the bot answers with recent conversation as context (`"transcript"`) or without (`"none"`). After the cutoff, it answers fresh, as after a timeout                  |
| Slack user answering an old approval    | The answer goes nowhere                                          | The answer is rejected and the stranded session is kept. Channel-specific feedback is still to do                                                                                      |
| HTTP or TUI client holding a session id | `session_not_active`, no reason                                  | `409 session_stranded` naming the cause, and the next step is to start a new session. `Session.send` throws `SessionStrandedError`. Unavailable owners get a retryable refusal instead |
| Operator                                | Every parked session fails at startup with `CORRUPTED_EVENT_LOG` | No failed replays. One warning per retirement naming the session, the reason, and both eve versions                                                                                    |
| Authored hooks                          | The old session fails. `session.started` fires for the new one   | The old session ends without running its code, so its terminal hooks don't fire. `session.started` fires for the replacement, with `data.replacement`                                  |
| Descendant runs                         | Orphaned until their own timeouts                                | Cancelled when the session is retired, or by cleanup at the cutoff                                                                                                                     |

Fixed-id callers are never redirected to a replacement. Explicit `reset` ends a stranded session.
`clear` refuses, because it would keep a session that can't run.

### Coordination

Normal session lifecycle is serialized by the owner run's inbox. Replacement is the one case where a
request handler acts on behalf of an owner that can't run, so the guarantees are sized to the cost
of each failure rather than built as a general transaction:

- **Hard.** Never execute obsolete code. Never cancel or steal a newer owner's claims. One owner per
  address, through the World's per-token hook claims.
- **Idempotent.** Every retirement step tolerates an earlier or concurrent attempt, so a sender's
  retry converges after a partial failure.
- **Tolerated.** A crash between retirement and the replacement's start degrades to an ordinary
  fresh session on retry, losing only the metadata and carried context. Duplicate terminal stream
  events and split replacements across one session's several aliases are tolerated unless measured
  to matter.
- During a handoff, refuse retryably rather than report the address as unowned.

### The main challenge: cleanup after the session timeout

Lazy preservation trades startup failure for a stranded run that stays `running` and keeps its
hooks until something retires it. A message retires it. But a session that never gets another
message has nothing to retire it: its timeout is enforced by a timer workflow that signals the
session to finalize itself, and both the timer and the finalizer run on old code that can no longer
execute. Without a separate path, every stranded session that goes quiet stays `running` forever,
along with its stream anchor, its claimed aliases, and any tasks, subagents, or workflow tools it
started. This is a regression from today, where the failed replay at least makes the run terminal.

So the core of this track is **cleanup that runs on current code, independent of user input and of
the old timeout workflows**:

1. Page through retired owners, resolving each session's authoritative owner and lifetime start.
2. Recheck the cutoff and any competing replacement or reset immediately before cancelling.
3. Retire the owner, its stream anchor, and its discoverable local descendants, and release only
   their hooks. Never cancel a runnable owner or an anchor a runnable owner still depends on.
4. Make progress resumable and bounded per pass, so a crash or a large backlog doesn't restart from
   scratch or block a host.

Cleanup creates no replacements, for top-level sessions or for descendants. Message-driven
retirement and explicit reset use the same descendant cleanup, rather than scanning the whole World
inside ingress.

The hard parts:

- **Where it runs.** A persistent `eve start` host can run it at startup, periodically, and soon
  after each retirement. Serverless hosts need a scheduled invocation or a World-owned job, not a
  best-effort interval. Nothing runs while every host is down; overdue work is processed when one
  returns. A cleanup workflow that itself depends on versioned code would strand at the next
  upgrade, so cleanup state must be readable without old-code replay.
- **Finding descendants.** Workflow stamps `$parentRunId` and `$rootRunId`, and eve stamps
  `$eve.root` and `$eve.session`, but the portable `runs.list` API can't filter by them, and there
  is no recursive cancel. A portable scan costs about one pass over all run records per sweep.
  Lineage must traverse terminal intermediates, such as a finished task that started a subagent,
  without cancelling unrelated Workflow roots. Runs from earlier releases that lack attribution can
  only be reported, not safely cancelled. Remote agents and external jobs are outside local
  cancellation, and cancellation never undoes side effects.
- **Interaction with authored timeouts.** An earlier authored timeout wins. A longer or disabled
  timeout can't extend preservation of a retired owner past 30 days. Healthy sessions are
  unchanged.
- **Racing replacement and reset.** Cleanup and a message-driven replacement can reach the same
  owner at once. Both must converge on one retirement, and a message that commits after the cutoff
  must not carry context even if cleanup hasn't run yet. Closing the check-then-cancel window
  cleanly may need a World-level conditional cancel.

If cleanup proves too complex to make reliable, the fallback is **eager retirement with lazy
replacement**: retire stranded runs at startup, keep a bounded record that maps each address to its
predecessor, and replace lazily from that record on the next message. That avoids long-lived
stranded runs but adds its own retention and arbitration problems for the predecessor index. Do not
ship indefinite preservation without one or the other.

### Tradeoffs

- **Retirement can't be undone.** A retired session can't be resumed by restoring its deployment or
  rolling back eve. To keep a rollback path, pin eve before upgrading, or with routing, keep the old
  build running.
- **The transcript is lossy.** The model doesn't see tool results or authored state, so it may need
  to redo lookups or ask again. In exchange, it adds almost no API and works the same on every
  channel and every World.
- One extra hook lookup per delivery on Worlds without `deploymentAffinity`. Runnable owners are
  cached, so steady state costs no run read.
- Cleanup adds a periodic background pass and, until a lineage query exists, scans whose cost grows
  with the number of runs.

## Considered and rejected

**Revive from checkpoints.** Revive would have read the stranded run's latest Workflow step input,
which holds the full session state, and started a new session seeded with its history, state,
limits, and usage. It recovers more than a transcript, but:

- it couples eve to Workflow internals: step inputs must be retained and hold the full state, and a
  `DURABLE_SESSION_VERSION` bump makes older sessions unrevivable;
- it needs a large API surface: a policy value, a command, an HTTP route, a `session.revived` event,
  `revivedFrom`, and a revive error;
- authors must handle lifecycle quirks: a new id, `session.started` firing again, and terminal hooks
  that never fire;
- pending work, approvals, descendants, credentials, and the sandbox are lost anyway, so for
  anything but idle sessions it degrades toward a reset;
- it adds a third migration mechanism next to handoff and legacy import.

Routing plus lazy replacement with a carried transcript covers most of the benefit. A custom
context hook covers apps that need more than the default transcript.

**Eager replacement.** Retiring stranded sessions at startup and creating each replacement
immediately, idle and waiting for the next message, was also investigated. It was rejected because
startup has no incoming request to initialize the replacement from: a Slack thread address alone
doesn't reconstruct the installation, audience, and reply state, and current continuation sends
don't carry the channel binding used at session creation. It would also need a World contract for
conditionally replacing a whole alias set during recovery, which doesn't exist today.

## Deferred: local World

Several processes can't share a local data directory: the caches are in-process, the queue lives in
memory, and every process re-enqueues every run on startup. Separate directories don't work either,
because handoff needs shared storage. Supporting several builds would take a supervisor that owns the
World and routes each delivery to a child process for that build, each with its own copy of eve.
The supervisor and children would also need an RPC protocol that stays compatible across eve
versions. Local users get lazy replacement. Postgres is the path for upgrades that keep sessions
running.

## Open questions

1. **Workflow commitment.** Will Workflow take on routing, the build registry, and expand-only
   migrations for world-postgres?
2. **Build id granularity.** Should every `eve build` get a new id, as on Vercel? Or should it change
   only when replay compatibility changes (the eve version plus a hash of the workflow code)? The
   second keeps fewer builds live for teams that release often.
3. **Cleanup on serverless and routed Worlds.** Is the in-process maintenance enough for persistent
   hosts, and what invokes it elsewhere: a scheduled task, or a World-owned job? Does closing the
   check-then-cancel window need a World conditional cancel?
4. **Descendant discovery.** Is a bounded portable scan acceptable until Workflow offers a lineage
   query or a subtree cancel?
5. **Transcript default.** Are the proposed bounds right? Should the default switch to
   `"transcript"` once its tests pass, and is it classified as a public-API change?
6. **Custom context hook.** Is there demand beyond what `"none"` plus the replacement metadata
   allows? If so, what timeout and fallback should it have?
