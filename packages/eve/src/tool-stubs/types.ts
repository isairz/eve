import type { JsonObject, JsonValue } from "#shared/json.js";

/** The JSON response returned for a matching tool call. */
export interface ToolStubOutcome {
  readonly response: JsonValue;
}

/** Stub outcomes selected by tool name and input fields. */
export type ToolStub = {
  readonly id: string;
  /** Use list_tasks for a root tool or researcher/list_tasks for a local subagent's tool. */
  readonly tool: string;
  /** Each named input property must exist and satisfy its JSON Schema. */
  readonly match?: Readonly<Record<string, JsonObject | boolean>>;
} & (
  | { readonly outcome: ToolStubOutcome; readonly outcomes?: never }
  | {
      readonly outcome?: never;
      readonly outcomes: readonly [ToolStubOutcome, ...ToolStubOutcome[]];
    }
);

export interface StubCall {
  /** Combines the session, turn, and tool call IDs. */
  readonly callId: string;
  readonly tool: string;
  readonly input: unknown;
  readonly persistent?: boolean;
}

export type StubResult =
  | { readonly kind: "real" }
  | { readonly kind: "error"; readonly error: string }
  | {
      readonly kind: "stub";
      readonly ruleId: string;
      readonly position: number;
      readonly outcome: ToolStubOutcome;
    };

/** Rules and workflow routing set by the server after it authorizes tool stubs. */
export interface StubScope {
  readonly token: string;
  readonly rules: readonly ToolStub[];
  readonly rootSessionId?: string;
  readonly agentPath?: string;
}

export const STUB_CONTEXT_KEY = "eve.toolStubs";
export const STUB_MATCHES_NAMESPACE = "eve.tool-stubs.matches";
export const STUB_FAILURE_NAMESPACE = "eve.tool-stubs.failure";
export const stubResponseNamespace = (callId: string): string => `eve.tool-stubs.${callId}`;
