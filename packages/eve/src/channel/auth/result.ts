import type { SessionAuthContext } from "#channel/types.js";
import type { AuthResult } from "#public/channels/auth.js";

/** Route permissions must not become persisted or forwarded principal metadata. */
export function sessionAuthFromResult(result: AuthResult): SessionAuthContext {
  const { allowToolStubs: _allowToolStubs, ...auth } = result;
  return auth;
}
