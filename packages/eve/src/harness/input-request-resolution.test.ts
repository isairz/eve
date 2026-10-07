import { describe, expect, it } from "vitest";
import {
  resolveApprovalOutcome,
  TOOL_EXECUTION_DENIED_MESSAGE,
} from "./input-request-resolution.js";

describe("resolveApprovalOutcome", () => {
  it.each(["cancel", "deny"])("keeps the note sent with a %s as the denial reason", (optionId) => {
    expect(
      resolveApprovalOutcome({
        optionId,
        requestId: "req-1",
        text: "  only the three-pack, with a $50 minimum ",
      }),
    ).toEqual({
      approved: false,
      reason: `${TOOL_EXECUTION_DENIED_MESSAGE} The person who denied it wrote: "only the three-pack, with a $50 minimum"`,
      status: "denied",
    });
  });

  it.each([undefined, "", "   "])("uses the bare denial when the note is %j", (text) => {
    expect(resolveApprovalOutcome({ optionId: "cancel", requestId: "req-1", text })).toEqual({
      approved: false,
      reason: TOOL_EXECUTION_DENIED_MESSAGE,
      status: "denied",
    });
  });
});
