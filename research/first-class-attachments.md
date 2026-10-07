---
issue: https://github.com/vercel/eve/issues/3833
status: proposed
last_updated: "2026-10-07"
---

# First-class attachments

## Summary

#4224 keeps attachment bytes out of session history: history holds refs, and
every model call hydrates them deterministically
([`research/tool-result-media.md`](./tool-result-media.md)). It left the store
backend to later work. Today the session sandbox is the only store, which
costs users in four ways:

- **Lost files.** Deployment-bound snapshots can drop staged bytes. #276
  reported the failure, and #325 made it degrade to a `FileNotFound` stub
  instead of failing the turn. The Slack docs still tell users to keep files
  elsewhere if they need them later (`docs/channels/slack.mdx`).
- **Sandbox boots.** Any attachment boots the sandbox. A vision-only Slack turn
  or a screenshot tool starts one just to show the model an image, and every
  model call reads the bytes back from it.
- **No handle.** An inline image reaches the model as bytes plus a `filename`
  that providers drop for images. The model sees the path only after
  compaction stubs the file, so it cannot pass a visible image to `bash` or
  reopen it by path.
- **Poisoned sessions.** Providers reject the whole request for one image over
  their pixel limits. History keeps the image, so every later call fails too.

This proposal adds a pluggable attachment store with the sandbox as the
default, so nothing changes without configuration. A durable store, such as
Vercel Blob, keeps files across snapshots and keeps the sandbox off the
attachment path. Two model-facing fixes ship first, independent of the store:
path labels and a pixel gate.

## Prerequisites

These fixes have direct user reports and ship as ordinary PRs. They are not
part of this plan.

- Slack thread lookback across recent messages (#705, PR #706).
- Skip Slack external files such as Google Drive links (#855, PR #856).
- Cancelled turns that persist a raw `eve-url:` part (#3419).
- Large web uploads by URL (#4194). The eve channel turns validated `http(s)`
  strings into `URL`s, and `eveChannel()` accepts `fetchFile`. Because URLs
  have no known size at the boundary, staging runs `uploadPolicy` again on the
  resolved bytes and media type. Resolvers get a byte cap and a timeout.
  Slack's resolver has no timeout today (`slack/attachments.ts:191`).

## Public API

| Import path              | Public surface                                                         |
| ------------------------ | ---------------------------------------------------------------------- |
| `eve/attachments`        | `defineAttachments`, `inMemory`, `AttachmentStore`, `Attachment` types |
| `eve/attachments/vercel` | `vercelBlob`                                                           |

```ts title="agent/attachments.ts"
import { defineAttachments } from "eve/attachments";
import { vercelBlob } from "eve/attachments/vercel";

export default defineAttachments({
  store: vercelBlob(),
});
```

`agent/attachments.ts` is optional, and there is no other public surface. A
declared subagent follows the slot isolation rule: it uses its own
`agent/subagents/<id>/attachments.ts`, or the default.

## Store contract

```ts
interface AttachmentStore {
  /** Idempotent: writing the same key twice with the same bytes succeeds. */
  put(input: {
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly filename: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
  get(input: {
    readonly key: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string } | null>;
}
```

Keys are `<sessionId>/<sha256>`. Content addressing makes step replays
idempotent and dedupes the same file across turns. `get` returns `null` only
when the object is gone for good. Transient failures throw, and the step
retries (rule 4 in `tool-result-media.md`). eve sets no retention policy and
deletes nothing; lifecycle rules belong to the store's owner.

## Store selection and resolution

| Configuration                  | Writes go to                                                   |
| ------------------------------ | -------------------------------------------------------------- |
| `agent/attachments.ts` present | The authored store                                             |
| Otherwise                      | The session sandbox, at `/workspace/.eve/attachments/` (today) |

Blob is opt-in. `vercelBlob()` reads only `EVE_ATTACHMENTS_BLOB_*`, never the
generic `BLOB_*`, so a project with an existing Blob store does not start
writing attachments into it. `eve integration setup attachments` provisions a
private store with that prefix and scaffolds `agent/attachments.ts`. File
memory's setup runner hard-codes its prefix (`file-memory/vercel.ts:13,280`).
Its runtime lookup already takes the prefix as a parameter. The plan extracts
one setup helper, parameterized by prefix, that both integrations use.

Reads try the configured store first, then the sandbox store. Adding Blob to a
live deployment therefore keeps earlier refs readable while the sandbox still
holds them. Refs whose bytes are in neither store render the missing-file stub.

## Refs

A stored attachment appears in history as a file part whose `data` is a ref:

```text
eve-attachment:?v=2&p=<base64url(JSON)>
```

The payload holds `id` (full sha256), `type`, `size`, `name`, and the optional
`width`, `height`, and `pages` that #4224's estimator uses. It uses the
base64url encoding of the existing v1 codec, so untrusted filenames cannot
inject fields. The decoder rejects duplicate query keys and unknown or
mistyped fields. v2 replaces the v1 `AttachmentRef` params format. Its only
non-test decoder call is in `internal/attachments/data.ts`.

The model-facing path is `/workspace/.eve/attachments/<id>/<name>`, with the
full sha, so a path maps to a store key without a lookup. Today's paths use a
16-hex prefix (`attachment-staging.ts:38`).

Refs are minted only by eve. `hasInternalRefScheme` keeps rejecting
caller-supplied internal schemes. `eve-sandbox:` refs already in history decode
to the same shape, keep their absolute path, and resolve through the same
chain, so live sessions keep their images.

## Ingestion

Bytes enter the store at the two points that stage them today, inside a
workflow step:

- **Channel inbound.** Staging writes the resolved bytes to the store. With a
  durable store it opens no sandbox.
- **Tool results.** #4224's ref pass writes to the store instead of the
  sandbox. This also covers turns where no sandbox resolves; today their
  tool-result bytes stay inline in history (`attachment-staging.ts:143-146`).

`read_file` on an image or PDF returns a file part, which the tool-result pass
stores. Attachment paths are read from the store first, so reopening a file
does not boot a sandbox when the store is durable.

When a durable store is configured and the session sandbox opens, eve writes
the attachments that current history references into the attachment
directory, so `bash` and Python see the same paths. The copy is bounded by
count and bytes.

## Model-facing changes

These follow the cache rules in `tool-result-media.md`: hydration is a pure
function of the ref, it never writes back to history, and media leaves the
model view only at compaction.

**Path labels.** Every attachment renders a text label, followed by its bytes
when it inlines:

```text
Attached file /workspace/.eve/attachments/<id>/chart.png (image/png, 1.2 MB, 1600x900)
```

The label is today's stub text with metadata added, so compaction keeps it.
Codex and pi label attachments the same way. Adding labels changes how
already-sent messages render, so each live session pays one prompt-cache
rewrite on upgrade. This is a one-time cost, comparable to a compaction.

**Pixel gate.** Images inline only when they are PNG, JPEG, GIF, or WebP, up to
3 MB, and at most 8000 px per side, using the dimensions already on the ref.
Anything else renders as the label alone. This covers tool-result refs too,
which always inline today
([Anthropic vision limits](https://platform.claude.com/docs/en/build-with-claude/vision)).
eve does not resize.

**PDFs in `read_file`.** An inbound PDF inlines, but after compaction stubs it,
`read_file` cannot reopen it, because `read_file` returns only images. `read_file`
returns PDFs up to 20 MB as file parts.

## Subagents

- **Built-in `agent` copies** share the parent's sandbox today, so they can open
  the parent's attachment paths. With a durable store they keep that ability:
  reads also resolve against the parent session's key prefix, found through
  `parentSessionId` lineage (`execution/workflow-runtime.ts:169`).
- **Declared subagents** get nothing from the parent, as today. The parent
  passes content through the subagent's `message`.

## Design invariants

- History that leaves a workflow step never holds attachment bytes.
- Hydration is a pure function of the ref.
- Every attachment the model sees carries a label with its path.
- A ref resolves only within its own session's prefix, or its parent's for
  built-in copies.
- Every dynamic ref field is encoded, and the decoder is strict.
- eve does not convert or resize files. It reads only image and PDF headers.
- Channel credentials stay inside `fetchFile` closures and are never written
  to refs or the store.

## Prior art

We read the attachment handling in opencode v2 (`dev` at `b1fe25a`), Codex
CLI (`9dd7988`), and pi (`f10993b`).

- All three keep base64 inline in a local history file. eve needs refs and a
  store because it persists history at every durable step. Codex's
  `AttachmentStore` (`Inline` or `File { file_id }`) is the closest analog to
  this seam.
- All three hydrate every call and evict only at compaction, as #4224 does.
- Codex and pi label each attachment with its path and reopen it with an
  ordinary read tool. opencode has no handle for user files.
- Codex and pi resize on insertion because one oversized image breaks the
  conversation. eve gates on stored dimensions instead, which needs no image
  dependency.

## Deferred

Each item lacks direct user demand or depends on something this plan does not
build.

- **Outbound files.** Slack already ships `thread.post({ files })` and
  `slack.uploadFiles` (`slack/api.ts:153,346`). If demand appears, a separate
  proposal starts from giving tools access to the channel. The same goes for a
  web download route.
- **`toModel` conversion hook** (for example, PDF to Markdown).
- **Pending Slack files** opened on demand. #706's bounded lookback covers #705.
- **Model capability gating** for vision, PDF, audio, and video (#543). eve has
  no model capability metadata yet.
- **Trace content.** Model-call spans record hydrated base64 when input
  recording is on. Replacing it with a placeholder is a tracing change.
- **Inlining small text files**, a programmatic `ctx.attachments` API,
  cross-session sharing, and retention.
- Provider URL passthrough. A signed URL changes each time it is minted, which
  breaks the cache rules.

## Rollout

1. **Model-facing fixes.** Path labels, the pixel gate, and PDFs in
   `read_file`. No new API, and independent of the store.
2. **Store seam.** The store contract, the internal sandbox store, v2 refs,
   and the resolution chain. Behavior is unchanged without configuration.
3. **Durable stores.** `defineAttachments`, `inMemory`, `vercelBlob`, the
   shared setup helper and `attachments` integration, sandbox copies on open,
   subagent lineage reads, and docs.

## Open questions for implementation

- Where the sandbox copy hooks into sandbox open without widening the core
  sandbox interface.
- Hydration reads a large PDF from Blob on every call. The per-process read
  cache from `tool-result-media.md` follow-ups likely becomes necessary.
- Count and byte caps for the sandbox copy.

## Verification

- **Unit:**
  - The ref codec, including injected filename fields and unknown or
    duplicate keys.
  - `eve-sandbox:` refs decoding to the v2 shape.
  - Labels and the pixel gate, for inbound and tool-result refs.
  - `read_file` on a PDF.
- **Integration:** staging and hydration against `inMemory()` across simulated
  step boundaries:
  - A replayed step.
  - A turn with no sandbox.
  - A pre-upgrade `eve-sandbox:` ref that still inlines.
  - Resolution after switching from the sandbox store to `inMemory()`.
  - A built-in copy reading its parent's attachment.
  - Byte-identical hydration across calls.
- **E2E (mock model):** a fixture with an authored `inMemory()` store sends an
  image over HTTP. The eval asserts that the model input contains the image
  and its label, that persisted history contains only `eve-attachment:` refs,
  and that the turn never opened a sandbox.

## Primary references

- `research/tool-result-media.md`
- `packages/eve/src/harness/attachment-staging.ts`
- `packages/eve/src/internal/attachments/`
- `packages/eve/src/tools/provided/read-file.ts`
- `packages/eve/src/public/memory/file/backend.ts`,
  `packages/eve/src/setup/integrations/file-memory/vercel.ts`
- `docs/subagents/index.mdx`
- Issues and PRs #276, #325, #705, #706, #855, #856, #3419, #4194, #4224
