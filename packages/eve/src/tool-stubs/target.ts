import type { StubScope } from "#tool-stubs/types.js";

/** Stub paths are separate from model-visible tool names. */
export function stubToolPath(scope: StubScope | undefined, tool: string): string {
  return scope?.agentPath === undefined ? tool : `${scope.agentPath}/${tool}`;
}
