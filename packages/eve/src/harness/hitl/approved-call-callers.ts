import type { SessionAuthContext } from "#channel/types.js";
import { runAsCaller } from "#context/caller-scope.js";
import { contextStorage } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { SessionView } from "#harness/session-machine/view.js";
import type { InputRequest } from "#shared/input.js";

/**
 * The person who approved each call the current step replays, by call id.
 * Step-local: set before the replay, never serialized.
 */
const ApprovedCallCallersKey = new ContextKey<ReadonlyMap<string, SessionAuthContext>>(
  "eve.approvedCallCallers",
);

/** Who approved each of the `approved` calls, by call id. */
export function approversOf(
  approved: readonly InputRequest[],
  view: SessionView,
): Readonly<Record<string, SessionAuthContext>> {
  const approvers: Record<string, SessionAuthContext> = {};
  for (const request of approved) {
    if (request.action === undefined) continue;
    const approver = view.turn.audit?.settlements[request.requestId]?.approver;
    if (approver !== undefined) approvers[request.action.callId] = approver;
  }
  return approvers;
}

/**
 * Records who approved each of the `approved` calls, so each runs as its approver while the rest
 * of the turn keeps the turn's own caller.
 */
export function setApprovedCallCallers(approved: readonly InputRequest[], view: SessionView): void {
  const ctx = contextStorage.getStore();
  if (ctx === undefined) return;
  ctx.setVirtualContext(
    ApprovedCallCallersKey,
    new Map(Object.entries(approversOf(approved, view))),
  );
}

/** Runs `fn` as the call's approver when `callId` is an approved call; otherwise as is. */
export function runAsApprover<T>(callId: string | undefined, fn: () => T): T {
  const approver =
    callId === undefined
      ? undefined
      : contextStorage.getStore()?.get(ApprovedCallCallersKey)?.get(callId);
  return approver === undefined ? fn() : runAsCaller(approver, fn);
}

/** A streaming call's body runs on each `next()`, so each one runs as the approver too. */
export async function* iterateAsApprover<T>(
  callId: string | undefined,
  iterable: AsyncIterable<T>,
): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await runAsApprover(callId, () => iterator.next());
      if (result.done === true) return;
      yield result.value;
    }
  } finally {
    await iterator.return?.();
  }
}
