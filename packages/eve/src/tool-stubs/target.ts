import type { StubScope } from "#tool-stubs/types.js";

/** Qualify names for stub matching without changing the names sent to the model. */
export function stubToolPath(scope: StubScope | undefined, tool: string): string {
  return scope?.agentPath === undefined ? tool : `${scope.agentPath}/${tool}`;
}
