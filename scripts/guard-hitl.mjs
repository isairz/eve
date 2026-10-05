/**
 * Rules 53 and 54 of `guard-invariants.mjs`. Rule 53: only the session machine
 * (`harness/session-machine/`) and human input (`harness/hitl/`) report
 * human input. Rule 54: the checkpoint reader workflow bodies use never reaches
 * the legacy-state migration. Kept apart so their cases are tested in
 * `guard-hitl.test.mjs`.
 */

const HUMAN_INPUT_DIR = "packages/eve/src/harness/hitl/";
const SESSION_MACHINE_DIR = "packages/eve/src/harness/session-machine/";
const EXEMPT_DIRS = ["packages/eve/src/protocol/", "packages/eve/src/internal/testing/"];
const TEST_FILE_RE = /\.(?:test|integration\.test|scenario\.test)\.ts$/;

const EVENT_BUILDER_RE =
  /\bcreate(?:Input(?:Requested|Resolved)|Authorization(?:Required|Completed)|Approval(?:Candidate|Settled))Event\b/g;
const WAITING_BUILDER_RE = /\bcreateTurnWaitingEvent\s*\(/g;
const EVENT_TYPE_RE =
  /\btype:\s*["'](input\.(?:requested|resolved)|authorization\.(?:required|completed)|approval\.(?:candidate|settled)|turn\.waiting)["']/g;

/**
 * @typedef {{ readonly line: number; readonly message: string }} HumanInputViolation
 * @param {string} posix repo-relative path
 * @param {string} text file contents
 * @returns {HumanInputViolation[]}
 */
export function checkHumanInputBoundary(posix, text) {
  if (
    !posix.startsWith("packages/eve/src/") ||
    posix.startsWith(HUMAN_INPUT_DIR) ||
    posix.startsWith(SESSION_MACHINE_DIR) ||
    EXEMPT_DIRS.some((dir) => posix.startsWith(dir)) ||
    TEST_FILE_RE.test(posix) ||
    posix.includes("/test/")
  ) {
    return [];
  }
  /** @type {HumanInputViolation[]} */
  const violations = [];
  /** @param {number} index @param {string} message */
  const report = (index, message) =>
    violations.push({ line: text.slice(0, index).split("\n").length, message });

  for (const match of text.matchAll(EVENT_BUILDER_RE)) {
    report(
      match.index,
      `uses ${match[0]} outside harness/session-machine/ and harness/hitl/. Only they build the events a request, approval, or authorization reports: return it from a session-machine transition so its readers hear it.`,
    );
  }
  for (const match of text.matchAll(WAITING_BUILDER_RE)) {
    const args = balanced(text, match.index + match[0].length - 1, "(", ")");
    if (/\bon:\s*["']tasks["']/.test(args)) continue;
    report(
      match.index,
      'builds a turn.waiting event that is not a runtime wait (on: "tasks") outside harness/session-machine/ and harness/hitl/. A turn waits on input only when human input holds it; return the hold from a session-machine transition so its readers hear it.',
    );
  }
  for (const match of text.matchAll(EVENT_TYPE_RE)) {
    const start = enclosingBrace(text, match.index);
    if (start === undefined) continue;
    const object = balanced(text, start, "{", "}");
    // A type, such as `Extract<…, { type: "input.requested" }>`, or an event
    // forwarded with the data it came with, builds nothing.
    const data = /\bdata:\s*\{/.exec(object);
    if (data === null) continue;
    if (match[1] === "turn.waiting" && /\bon:\s*["']tasks["']/.test(object)) continue;
    report(
      match.index,
      `builds a ${match[1]} event by hand outside harness/session-machine/ and harness/hitl/. Only they build the events a request, approval, authorization, or input wait reports; forward an existing event's data, or return it from a session-machine transition.`,
    );
  }
  return violations.sort((a, b) => a.line - b.line);
}

/** The text from `open` at `start` to its matching `close`. */
function balanced(text, start, open, close) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === open) depth++;
    else if (text[index] === close && --depth === 0) return text.slice(start, index + 1);
  }
  return text.slice(start);
}

/** The index of the `{` that opens the object literal around `index`. */
function enclosingBrace(text, index) {
  let depth = 0;
  for (let at = index - 1; at >= 0; at--) {
    if (text[at] === "}") depth++;
    else if (text[at] === "{" && depth-- === 0) return at;
  }
  return undefined;
}

/** Workflow bodies read checkpoints through these files, so they ship in the workflow bundle. */
const WORKFLOW_CHECKPOINT_READERS = new Set([
  "packages/eve/src/execution/durable-session-read.ts",
  "packages/eve/src/execution/session/active-turn.ts",
]);
const CHECKPOINT_READER = "packages/eve/src/execution/durable-session-read.ts";
const IMPORT_RE = /^\s*(import|export)\s+(type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']/gm;
const HYDRATING_IMPORT_RE =
  /(?:^|\/)(?:durable-session-store|session-machine\/hydrate|hitl\/migration)\.js$/;

/**
 * Rule 54: legacy-state migration pulls human input, its projections, and their
 * schemas into the workflow bundle. Workflow-side readers stay free of it; step
 * code hydrates through `#execution/durable-session-store.js`.
 * @param {string} posix repo-relative path
 * @param {string} text file contents
 * @returns {HumanInputViolation[]}
 */
export function checkWorkflowCheckpointReader(posix, text) {
  if (!WORKFLOW_CHECKPOINT_READERS.has(posix)) return [];
  /** @type {HumanInputViolation[]} */
  const violations = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    if (match[2] !== undefined) continue;
    const specifier = match[3];
    const start = match.index + match[0].length - match[0].trimStart().length;
    const line = text.slice(0, start).split("\n").length;
    if (posix === CHECKPOINT_READER) {
      violations.push({
        line,
        message: `imports ${specifier} at runtime. The workflow-side checkpoint reader only validates and extracts the checkpoint; import types only, and hydrate in step code through #execution/durable-session-store.js.`,
      });
    } else if (HYDRATING_IMPORT_RE.test(specifier)) {
      violations.push({
        line,
        message: `imports ${specifier}, which migrates legacy state, into a workflow body. Read the checkpoint through #execution/durable-session-read.js; step code hydrates it.`,
      });
    }
  }
  return violations.sort((a, b) => a.line - b.line);
}
