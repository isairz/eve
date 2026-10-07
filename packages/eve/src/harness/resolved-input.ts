import type { StepCoordinates as PendingInputBatchEvent } from "#harness/session-machine/view.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

export const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution was denied.";

type ApprovalTerminalStatus = "approved" | "denied" | "ignored" | "invalid";

export interface ResolvedInputBatch {
  readonly event: PendingInputBatchEvent;
  readonly inputs: readonly {
    readonly outcome: "answered" | ApprovalTerminalStatus;
    readonly request: InputRequest;
    readonly response?: InputResponse;
  }[];
}
