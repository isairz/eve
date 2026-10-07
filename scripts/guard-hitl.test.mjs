import assert from "node:assert/strict";
import test from "node:test";

import { checkHumanInputBoundary, checkWorkflowCheckpointReader } from "./guard-hitl.mjs";

const OUTSIDE = "packages/eve/src/harness/tool-loop.ts";

/** @param {string} text @param {string} [posix] */
const lines = (text, posix = OUTSIDE) =>
  checkHumanInputBoundary(posix, text).map((violation) => violation.line);

test("flags human input changed outside harness/hitl/", () => {
  assert.deepEqual(lines("const event = createInputRequestedEvent({ requests });"), [1]);
  assert.deepEqual(lines("emit(createAuthorizationCompletedEvent(challenge, outcome));"), [1]);
});

test("flags a turn waiting on input, built or by hand", () => {
  assert.deepEqual(
    lines(
      'emit(\n  createTurnWaitingEvent({\n    on: "input",\n    sequence,\n    turnId,\n  }),\n);',
    ),
    [2],
  );
  assert.deepEqual(lines("emit(createTurnWaitingEvent({ on, sequence, turnId }));"), [1]);
  assert.deepEqual(
    lines('emit({ type: "turn.waiting", data: { on: "input", sequence, turnId } });'),
    [1],
  );
});

test("flags a human input event built by hand", () => {
  assert.deepEqual(
    lines('await emit({\n  type: "input.requested",\n  data: { requests, sequence, turnId },\n});'),
    [2],
  );
  assert.deepEqual(
    lines('await emit({\n  data: { nested: { at }, requests },\n  type: "approval.settled",\n});'),
    [3],
  );
});

test("allows runtime waits, forwarded events, types, and inputs", () => {
  assert.deepEqual(
    lines('emit(createTurnWaitingEvent({ on: "tasks", sequence, turnId, usage }));'),
    [],
  );
  assert.deepEqual(
    lines('emit({ type: "turn.waiting", data: { on: "tasks", sequence, turnId } });'),
    [],
  );
  assert.deepEqual(lines('await forward({ data, type: "authorization.required" }, ctx);'), []);
  assert.deepEqual(lines('await forward({ data: event.data, type: "input.requested" });'), []);
  assert.deepEqual(
    lines('type Requested = Extract<MessageStreamEvent, { type: "input.requested" }>;'),
    [],
  );
  assert.deepEqual(
    lines('await commitTurn(postStep, session, { challenges, type: "authorization.required" });'),
    [],
  );
});

test("allows human input itself, the protocol, and tests", () => {
  const built = "emit(createInputRequestedEvent({ requests }));\nTurn.idle().input(x);";
  assert.deepEqual(lines(built, "packages/eve/src/harness/hitl/relayed.ts"), []);
  assert.deepEqual(lines(built, "packages/eve/src/protocol/message.ts"), []);
  assert.deepEqual(lines(built, "packages/eve/src/internal/testing/hitl.ts"), []);
  assert.deepEqual(lines(built, "packages/eve/src/harness/tool-loop.test.ts"), []);
});

test("allows the session machine to report human input", () => {
  assert.deepEqual(
    lines(
      "const event = createInputRequestedEvent({ requests });",
      "packages/eve/src/harness/session-machine/transitions.ts",
    ),
    [],
  );
});

const READER = "packages/eve/src/execution/durable-session-read.ts";
const ACTIVE_TURN = "packages/eve/src/execution/session/active-turn.ts";

/** @param {string} posix @param {string} text */
const readerLines = (posix, text) =>
  checkWorkflowCheckpointReader(posix, text).map((violation) => violation.line);

test("flags a runtime import in the workflow-side checkpoint reader", () => {
  assert.deepEqual(
    readerLines(
      READER,
      'import type { DurableSession } from "#execution/durable-session-store.js";\nimport { hydrateMachineState } from "#harness/session-machine/hydrate.js";',
    ),
    [2],
  );
  assert.deepEqual(readerLines(READER, 'import { x } from "#shared/json.js";'), [1]);
});

test("flags a hydrating import in a workflow body", () => {
  assert.deepEqual(
    readerLines(
      ACTIVE_TURN,
      'import { readDurableSession } from "#execution/durable-session-read.js";\nimport { readDurableSession as r } from "#execution/durable-session-store.js";\nimport {\n  migrateLegacyParkingState,\n} from "#harness/hitl/migration.js";',
    ),
    [2, 3],
  );
});

test("allows types, the plain reader, and step code that hydrates", () => {
  assert.deepEqual(
    readerLines(
      READER,
      'import type { DurableSession } from "#execution/durable-session-store.js";',
    ),
    [],
  );
  assert.deepEqual(
    readerLines(
      ACTIVE_TURN,
      'import { readDurableSession } from "#execution/durable-session-read.js";\nimport type { S } from "#execution/durable-session-store.js";',
    ),
    [],
  );
  assert.deepEqual(
    readerLines(
      "packages/eve/src/execution/turn-step.ts",
      'import { readDurableSession } from "#execution/durable-session-store.js";',
    ),
    [],
  );
});

test("forbids the centralized migrator in both workflow modules", () => {
  for (const module of [READER, ACTIVE_TURN]) {
    assert.deepEqual(
      readerLines(
        module,
        'import { migrateSessionState } from "#harness/session-machine/migrate.js";',
      ),
      [1],
    );
    assert.deepEqual(
      readerLines(
        module,
        'import { readState } from "#harness/session-machine/migrate-legacy.js";',
      ),
      [1],
    );
  }
});
