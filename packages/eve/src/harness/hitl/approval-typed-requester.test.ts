import { describe, expect, it } from "vitest";

import { ALICE, BOB, message, waitingOnApprovals } from "#internal/testing/hitl.js";

// A typed "approve" or "cancel" answers a direct approval through the same
// requester gate as a button press, and names who typed it.
describe("typed approval requester boundary", () => {
  it.each(["approve", "cancel"])(
    "consumes another principal's typed %s without settling",
    (text) => {
      const turn = waitingOnApprovals("deploy").input(message(text, BOB));
      expect(turn.published("approval.settled")).toEqual([]);
      expect(turn.published("input.resolved")).toEqual([]);
      expect(turn.stored().humanInput.openRequestIds()).toEqual(new Set(["deploy"]));
      expect(turn.published("message.completed").map(({ data }) => data.message)).toEqual([
        "Only the person who requested this action can respond to this approval.",
      ]);
    },
  );

  it.each(["approve", "cancel"])("lets the requester settle with a typed %s", (text) => {
    const turn = waitingOnApprovals("deploy").input(message(text, ALICE));
    expect(turn.published("approval.settled")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ responderPrincipalId: ALICE.principalId }),
      }),
    ]);
    expect(turn.stored().humanInput.openRequestIds()).toEqual(new Set());
  });
});
