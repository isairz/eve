import { getProxyInputRequests as getRelayedRequests } from "#harness/session-machine/migrate-legacy.js";
import { describe, expect, it } from "vitest";

import type { HarnessSession } from "#harness/types.js";

const REQUEST_EVENT = { sequence: 0, stepIndex: 0, turnId: "turn_0" };

function createSession(state?: Record<string, unknown>): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
    state,
  };
}

describe("getRelayedRequests type safety", () => {
  it("returns an empty map when the session carries no proxy state", () => {
    const entries = getRelayedRequests(createSession().state);
    expect(entries.size).toBe(0);
  });

  it("ignores malformed values in the state map", () => {
    const session = createSession({
      "eve.runtime.proxyInputRequests": {
        "req-1": 42,
        "req-2": { childContinuationToken: 42, event: REQUEST_EVENT, kind: "question" },
        "req-3": { childContinuationToken: "child-c", kind: "other" },
        "req-4": { childContinuationToken: "child-d", event: REQUEST_EVENT, kind: "question" },
      },
    });
    const entries = getRelayedRequests(session.state);
    expect(entries.size).toBe(1);
    expect(entries.get("req-4")).toEqual({
      childContinuationToken: "child-d",
      event: REQUEST_EVENT,
      kind: "question",
    });
  });

  it("ignores a legacy array-shaped value", () => {
    const session = createSession({
      "eve.runtime.proxyInputRequests": [{ requestId: "req-1" }],
    });
    expect(getRelayedRequests(session.state).size).toBe(0);
  });

  it("keeps legacy routes and ignores malformed optional batch metadata", () => {
    const session = createSession({
      "eve.runtime.proxyInputRequests": {
        legacy: { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" },
        malformed: {
          batch: { approvalRequestIds: ["other"], requestIds: ["malformed"] },
          childContinuationToken: "child-a",
          event: REQUEST_EVENT,
          kind: "tool-approval",
        },
      },
    });

    expect([...getRelayedRequests(session.state)]).toEqual([
      ["legacy", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
      [
        "malformed",
        { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "tool-approval" },
      ],
    ]);
  });
});
