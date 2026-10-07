---
issue: https://github.com/vercel/eve/issues/3833
status: proposed
last_updated: "2026-10-07"
---

# First-class attachments

## Summary

Files reach an agent from channels (a Slack image, a PDF uploaded in web chat),
from tools (a screenshot returned through `toolOutputPart.file`), and from the
sandbox (a report the agent downloaded with `curl`). #4224 already keeps
attachment bytes out of session history: history holds `eve-sandbox:` refs, and
every model call hydrates them deterministically
([`research/tool-result-media.md`](./tool-result-media.md)). That plan left
the store backend to this work. Today the session sandbox is the only store,
and that causes most of the file problems users still report:

- Attachments vanish when a deployment-bound sandbox snapshot changes (#325),
  and the Slack docs tell users to keep files elsewhere if they need them later.
- Any attachment boots the sandbox. A vision-only Slack turn or a screenshot
  tool starts one just to show the model an image, and every model call reads
  the bytes back from it.
- The eve channel passes `https://` file strings through to the provider, so
  web clients can't send large uploads by URL (#4194). Unstaged channel URLs fail
  with `AI_DownloadError` on every later turn (#855, #3419).
- `read_file` shows images but not PDFs. An inline attachment reaches the
  model without its path, so the model can reopen it only after compaction
  stubs it.
- Agents cannot send a file they produced back to the user. Internal agents
  maintain four hand-rolled copies of Slack's upload flow.

This proposal adds `eve/attachments`: a pluggable attachment store modeled on
the file-memory backend seam. The sandbox stays as the fallback store, so
nothing regresses without configuration. A durable store such as Vercel Blob
removes the sandbox from the attachment path entirely. History keeps compact
refs, hydration keeps the cache rules from #4224, and the sandbox receives a
copy only when a tool needs one.

eve does no document processing. PDFs and images go to the provider natively.
A single `toModel` hook lets authors replace what the model sees for an
attachment, for example by converting a PDF to Markdown with a third-party
parser.

## Public API at a glance

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

`agent/attachments.ts` is optional. Without it, eve selects the default store
described in [Store selection](#store-selection). Subagents use the parent
agent's store; attachments themselves are scoped per session.

## Store contract

```ts
interface AttachmentStore {
  /** Idempotent: writing the same key twice with the same bytes succeeds. */
  put(input: {
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly filename?: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
  get(input: {
    readonly key: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string } | null>;
}
```

Keys are `<sessionId>/<sha256>`. Content addressing makes workflow-step
replays idempotent and dedupes the same upstream file across turns. Scoping by
session means a ref can only resolve inside the session that holds it.
Backends may prepend their own prefix (`vercelBlob` defaults to
`eve/attachments`). `get` returns the stored media type, so a caller that only
has a path, such as `read_file`, can build a file part.

`get` returns `null` only when the object is gone for good. Transient failures
throw, and the step retries (rule 4 in `tool-result-media.md`).

eve sets no retention policy and deletes nothing. Most blob stores do not
support per-object TTLs, so lifecycle rules belong to the store's owner.

### Store selection

| Environment                    | Store                                         |
| ------------------------------ | --------------------------------------------- |
| `agent/attachments.ts` present | The authored store                            |
| Vercel with Blob credentials   | Private Vercel Blob                           |
| Everywhere else, `eve dev` too | The session sandbox (today's behavior, #4224) |

The sandbox store writes `/workspace/.eve/attachments/<sha>/<name>`, the same
layout #4224 uses. It keeps today's costs: attachments boot the sandbox,
hydration needs a running sandbox, and snapshot changes can lose files. It is
internal and not exported. `eve build` notes when the deployment falls back to
it while a channel accepts uploads, and names the fix: add
`agent/attachments.ts` or run `eve integration setup attachments`.

On Vercel the default reads `EVE_ATTACHMENTS_BLOB_*` first, then generic
`BLOB_*`, using the same token and OIDC rules as file memory. File memory's
Blob credential lookup and provisioning hard-code the `EVE_MEMORY_` prefix
(`setup/integrations/file-memory/vercel.ts`,
`public/memory/file/backends/default.ts`). Step 2 extracts them into one
helper that takes the prefix as a parameter. File memory and a new
`attachments` integration (`eve integration setup attachments`, plus a
registry item) both use it.

Changing stores does not migrate objects. A ref whose bytes are not in the
current store renders the missing-file stub.

## Refs in history

A stored attachment appears in history as a file part whose `data` is a ref:

```text
eve-attachment:?v=2&p=<base64url(JSON)>
```

The JSON payload holds `id` (sha256), `type`, `size`, `name`, and the optional
`width`, `height`, and `pages` the estimator uses. When `toModel` produced
output, it also holds `model: { id, type, size }`. The payload uses the
base64url encoding the v1 codec already uses (`internal/attachments/refs.ts`),
so untrusted filenames and media types cannot inject fields. The decoder
rejects duplicate query keys and unknown or mistyped payload fields.

Refs are minted only by eve. The existing channel-boundary check
(`hasInternalRefScheme`) keeps rejecting caller-supplied internal schemes.
v2 replaces the unused v1 `AttachmentRef` params format.

`eve-sandbox:` refs already in history keep working. The decoder maps them to
the same shape and reads them from the sandbox store, so live sessions keep
seeing their images after an upgrade. New refs are always v2.

## Ingestion

Attachments enter the store inside a workflow step.

1. **Channel inbound.** `fetchFile` keeps its current contract. Staging writes
   the resolved bytes to the store, and opens no sandbox unless the sandbox is
   the store.
   - The eve channel turns validated `http(s)` strings into `URL`s at the
     boundary, after the `hasInternalRefScheme` check, and `eveChannel()` gains
     `fetchFile` (#4194). Web clients can then upload to their own storage and
     send a URL.
   - Inline base64 and data-URL parts cross the dispatch payload once, capped by
     `uploadPolicy.maxBytes`, and are stored in the first step. Larger files
     should use a URL.
2. **Tool results.** #4224's ref pass is unchanged. It writes to the store
   instead of the sandbox. Authors keep using `toolOutputPart.file`.
3. **Sandbox files.** `read_file` on an image or PDF returns a file part,
   which the ref pass stores (see [Model-facing tools](#model-facing-tools)).
4. **Programmatic.** Tool and channel contexts expose
   `attachments.put({ bytes, mediaType, filename })`, which returns an
   `Attachment`, and `attachments.read(attachment)`.

### Upload policy

`uploadPolicy` runs at the channel boundary on the declared media type and any
known size, as today. A URL has no known size there, so staging runs the
policy again on the resolved bytes and media type before `put`, and rejects on
violation. `fetchFile` resolvers must stream with a byte cap of
`uploadPolicy.maxBytes` and a timeout. The built-in resolvers do.

## The `toModel` hook

```ts title="agent/attachments.ts"
import { defineAttachments } from "eve/attachments";
import { vercelBlob } from "eve/attachments/vercel";
import { pdfToMarkdown } from "../lib/pdf";

export default defineAttachments({
  store: vercelBlob(),
  async toModel(attachment) {
    if (attachment.mediaType !== "application/pdf") return;
    return { type: "text", text: await pdfToMarkdown(await attachment.bytes()) };
  },
});
```

`toModel(attachment, ctx)` runs once, when a channel or sandbox attachment
enters the store. It does not run for tool results, because tools already
control their model output through `toModelOutput`.

| Return                               | The model sees                                      |
| ------------------------------------ | --------------------------------------------------- |
| `undefined`                          | The original, under the native policy               |
| `{ type: "text", text }`             | The text, in place of the file                      |
| `{ type: "file", bytes, mediaType }` | The replacement file (for example, a smaller image) |

eve stores the output as its own content-addressed object and records its
`id`, `type`, and `size` on the ref, so a PDF can become a PNG. The original
stays in the store for `read_file`, the sandbox copy, and outbound delivery.
When a sandbox opens, text output is copied next to the original as
`<name>.md`, so the agent can search it with sandbox tools.

Replay never changes what the model sees. The output becomes visible only
through the ref, which commits with the step. If a step is interrupted after
the `put`, the replay runs `toModel` again and commits whatever it produces
then. The earlier object is never referenced. Converters can be
nondeterministic, LLM-based ones included. The cost is a second conversion on
replay.

If `toModel` throws, eve logs the error and falls back to the native policy for
that attachment. The turn continues.

## Model-facing policy

Hydration follows the prompt-cache rules in `tool-result-media.md`. It is a
pure function of the ref and the model's input capabilities, it never writes
back to history, and it renders every ref on every call. Media leaves the
model view only at compaction.

Every attachment renders a label, and its content follows when it is eligible
to inline:

```text
Attached file /workspace/.eve/attachments/<sha>/chart.png (image/png, 1.2 MB, 1600x900)
```

Today the path appears only in stubs. An inline image reaches the model as
bytes and a filename that some providers drop, so the model cannot reopen it
or hand it to `bash`. The label fixes that and makes the path the model's
handle in practice. Codex and pi label attachments the same way (see
[Prior art](#prior-art)).

| Content                          | Inlines when                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Images                           | ≤ 3 MB, ≤ 8000 px per side, and the model accepts images                                                |
| PDFs                             | ≤ 20 MB and the model accepts PDFs                                                                      |
| Text (`text/*`, JSON, YAML, CSV) | ≤ 64 KB, as a text part                                                                                 |
| Video and audio                  | The model family accepts them (#543)                                                                    |
| `toModel` output                 | Always, in place of the original. Text beyond 64 KB is truncated with a note pointing at the `.md` copy |

Anything else renders as the label alone. The pixel gate uses the dimensions
already stored on the ref. It exists because providers reject the whole
request for one oversized image
([Anthropic vision limits](https://platform.claude.com/docs/en/build-with-claude/vision)),
and because history keeps the image, every later call fails too. eve does not
resize. Authors who need oversized images seen use `toModel`.

Capability gating applies to a per-call copy, as in Codex and pi. Switching
to a model without vision shows labels, and switching back restores the
images. A model switch already changes the prompt, so this keeps the cache
rules.

Compaction stubs older attachments in one pass, as it does for tool media
today, keeping the label. `read_file` reopens them.

## Model-facing tools

The attachment path, `/workspace/.eve/attachments/<sha>/<name>`, is the
model's single handle for a file.

- `read_file` returns images and PDFs as file parts under the same inline
  rules as hydration. Attachment paths are read from the store first, so
  reopening a file does not boot a sandbox when the store is durable. Files
  over the inline limits return an error that suggests sandbox tools.
- `read_file` also opens pending channel files (see [Slack](#slack)), so the
  model never needs a separate attachment tool.
- When a durable store is configured and eve opens a session sandbox, it writes
  the attachments that current history references, if they are missing from
  the attachment directory. `bash`, Python, and other tools see the same paths.

## Sending files to users

- An `attach_file({ path })` tool is available when the active channel supports
  outbound files. It stores the file and adds it to the turn's outbound list.
- The outbound list is published once, on `turn.completed`, as
  `attachments: readonly AttachmentDescriptor[]`. Descriptors are JSON-safe
  (`id`, `name`, `mediaType`, `size`) because stream events are serialized.
  Failed and cancelled turns deliver nothing.
- Channel renderers resolve bytes through `ctx.attachments.read(descriptor)`.
  The Slack default renderer uploads them in the reply thread, deduped per
  thread by sha, which requires `files:write`. Teams and Telegram follow the
  same pattern.
- Web clients get a download URL served by
  `GET /eve/v1/sessions/:id/attachments/:sha`. The route authorizes the caller
  against that session before reading the store.

## Tracing

When input recording is on, model-call spans record the hydrated prompt
(`ai.prompt`, `gen_ai.input.messages`), so trace exporters receive base64
media. With refs, spans record the attachment descriptor in place of inline
bytes. Trace viewers resolve the descriptor through the session-authorized
download route instead of storing a copy.

Providers still receive bytes, not URLs. A signed store URL changes every time
it is minted, which breaks the cache rule that a sent message renders
byte-identically. Private URLs also fail when the provider fetches them, as
in #855. See [Non-goals](#non-goals).

## Slack

- **Lookback.** Collect files across a bounded window of recent thread
  messages, including bot-authored roots (#705, #706).
- **Remote files.** Skip `mode: "external"` files such as Google Drive or
  Dropbox links (#855, #856).
- **Push the trigger, pull the rest.** Files on the triggering message are
  stored with the turn. Files on earlier messages in the lookback window are
  listed as labels without bytes, under a pending path:

  ```text
  Attached file /workspace/.eve/attachments/pending/<fileId>/report.pdf (application/pdf, 2.1 MB). Not loaded yet; open it with read_file.
  ```

  When the model opens one, `read_file` fetches it through the channel's
  `fetchFile`, applies `uploadPolicy`, stores it, runs `toModel`, and returns
  it as a file part with its stored path. The listing never changes, so the
  prompt stays cache-stable. pi uses the same pattern for pasted images: it
  writes a path into the message and lets the model `read` it.

Pending paths are not capabilities. When eve lists a pending file, it records
the locator in session state with the channel's file descriptor. `read_file`
resolves only locators recorded for that session and rejects any other
pending path, so a model or prompt injection cannot fetch arbitrary channel
files by guessing ids. Pending files do not exist in the sandbox until opened.

## Design invariants

- History that leaves a workflow step never holds attachment bytes.
- Hydration is a pure function of the ref and the model's input capabilities.
  It never depends on turn age, media count, or time.
- Every attachment the model sees carries a label with its path.
- A pending path resolves only if eve listed it in the same session.
- Storing originals is idempotent per step replay. `toModel` output reaches the
  model only through a committed ref.
- A ref resolves only within its own session's key prefix.
- Every dynamic ref field is encoded, and the decoder is strict.
- eve does not convert or resize files. It reads only image and PDF headers
  for metadata. `toModel` is the only transformation point.
- Channel credentials stay inside `fetchFile` closures and are never written
  to refs, the store, or traces.

## Prior art

We read the attachment paths of three coding-agent harnesses: opencode v2
(`dev` at `b1fe25a`), Codex CLI (`9dd7988`), and pi (`f10993b`).

|                | opencode v2                                   | Codex                                                                                                            | pi                                                                     |
| -------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Storage        | base64 `data:` URIs in SQLite JSON            | base64 in rollout JSONL, behind an `AttachmentStore` seam (`Inline` or `File { file_id }`), inline in production | base64 in session JSONL                                                |
| Re-read handle | Path in `read` arguments; none for user files | `<image path="…">` label around each image, plus `view_image(path)`                                              | `<file name="…">` label, plus `read(path)`                             |
| Eviction       | Compaction only                               | Compaction only, plus a per-call placeholder for models without images                                           | Compaction only, plus a per-call placeholder for models without images |
| Normalization  | `read` resizes; user files don't              | Resize once on insertion, never on replay                                                                        | Resize once on insertion                                               |
| Compaction     | All media becomes `[Attached mime: name]`     | Local drops media and labels; remote keeps the newest images within a budget                                     | Images dropped from the summary without a marker                       |

What this plan takes from them:

- **Confirmed.** All three hydrate deterministically and evict only at
  compaction, as #4224 does. None uses a per-call media budget. All three move
  tool-result images into a following user message for Chat Completions APIs.
- **Adopted.** A path label on every attachment, per-call capability
  placeholders, and resolving pending files through the ordinary read tool,
  following pi's pasted-image flow.
- **Adapted.** Codex and pi resize on insertion because one oversized image
  breaks the conversation for good. eve gates inlining on stored dimensions
  instead, and leaves conversion to `toModel`, which keeps the runtime free of
  image dependencies.
- **Different by necessity.** None of them uses an external store, because
  their history is a local file. eve persists history at every durable step,
  which is why refs and a store are needed. Codex's `AttachmentStore` is the
  closest analog to this seam, and its replay rule ("must not upload or
  migrate recorded history") matches how this plan treats `toModel` on
  replay.
- **Weak spots to avoid.** Handles get lost for pasted and tool-output media,
  and compaction drops labels in Codex (local) and pi. eve keeps the label
  through compaction.

## Follow-ups

- A compaction trigger for provider media limits. Above 20 images per request,
  Anthropic rejects any image over 2000 px, counting images resent from
  history. The ref already carries the dimensions.
- Keeping the newest images through compaction within a token budget, as
  Codex's remote compaction does, instead of stubbing them all.

## Non-goals

- PDF, Office, or image processing inside eve.
- Retention, TTLs, or deletion.
- Provider URL passthrough with signed store URLs. It conflicts with the cache
  rules, and Provider Files API uploads (`file_id`) are the better
  optimization if one is needed.
- Sharing attachments across sessions. Passing files to subagents and remote
  agents (by copying into the child session's prefix) is a follow-up.
- Browser direct-upload routes. These need an opaque, server-validated upload
  id, because client-supplied refs are rejected. Follow-up.

## Rollout

1. **Fixes with no new API.** #706, #856, `http(s)` strings and `fetchFile` on
   `eveChannel` (#4194), upload policy on resolved bytes, path labels on every
   attachment, the pixel and capability gates, PDFs in `read_file`, and
   inlining small text files.
2. **Store and refs.** `eve/attachments`, `inMemory`, `vercelBlob`, the
   internal sandbox store, store selection, v2 refs, ingestion and hydration
   through the store, sandbox copies on open, the shared Blob setup helper,
   the `attachments` integration, and docs.
3. **Model-facing policy.** `toModel`, model-aware video and audio, trace
   descriptors, and pending Slack files through `read_file`.
4. **Outbound.** `attach_file`, `turn.completed` attachments, channel
   renderers, and the web download route.

## Verification

- Unit: the ref codec, including injected filename fields and unknown or
  duplicate keys; `eve-sandbox:` refs decoding to the v2 shape; store
  selection probes; hydration policy, including labels, the pixel gate, and
  capability placeholders; `toModel` result handling; upload policy on
  resolved bytes.
- Integration: staging and hydration against `inMemory()` across simulated
  step boundaries, covering a missing sandbox, a replayed step that reruns a
  nondeterministic `toModel`, an `eve-sandbox:` ref from before the upgrade
  that still inlines, byte-identical hydration across calls, and a model
  switch away from vision and back. `read_file` opens a listed pending file
  and rejects an unlisted pending path.
- E2E (mock model): an HTTP-channel eval that sends an image and a PDF by URL,
  asserts that the model input contains file parts, and asserts that persisted
  history contains only `eve-attachment:` refs. A second eval covers
  `read_file` on a sandbox PDF.

## Primary references

- `research/tool-result-media.md`
- `packages/eve/src/harness/attachment-staging.ts`
- `packages/eve/src/internal/attachments/`
- `packages/eve/src/eve-channel/request.ts`
- `packages/eve/src/public/channels/upload-policy.ts`
- `packages/eve/src/public/channels/slack/attachments.ts`
- `packages/eve/src/public/memory/file/backend.ts`,
  `packages/eve/src/public/memory/file/backends/default.ts`,
  `packages/eve/src/setup/integrations/file-memory/vercel.ts`
- `packages/eve/src/tracing/content-attributes.ts`
- Issues and PRs #325, #543, #705, #706, #855, #856, #3419, #4194, #4224
