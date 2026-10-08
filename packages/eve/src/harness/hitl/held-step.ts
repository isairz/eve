import type { ModelMessage } from "ai";

/**
 * `messages` without these calls and their results, so the model calls them
 * again once authorized. An assistant message the calls leave with only text
 * goes too: it narrated calls that never happened.
 */
export function withoutCalls(
  messages: readonly ModelMessage[],
  callIds: ReadonlySet<string>,
): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const stopped = message.content.some(
        (part) => part.type === "tool-call" && callIds.has(part.toolCallId),
      );
      const content = message.content.filter(
        (part) => part.type !== "tool-call" || !callIds.has(part.toolCallId),
      );
      const hasOtherCall = content.some((part) => part.type === "tool-call");
      return content.length === 0 || (stopped && !hasOtherCall) ? [] : [{ ...message, content }];
    }
    if (message.role === "tool") {
      const content = message.content.filter(
        (part) => part.type !== "tool-result" || !callIds.has(part.toolCallId),
      );
      return content.length === 0 ? [] : [{ ...message, content }];
    }
    return [message];
  });
}

/**
 * Rejects runtime calls whose ids repeat, before any result can bind to the
 * wrong one. Kept here, not shared with coordination, because human input
 * runs in the workflow body, where coordination's imports can't.
 */
export function assertUniqueCallIds(requests: readonly { readonly callId: string }[]): void {
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.callId)) {
      throw new Error(`Coordination batch contains duplicate callId "${request.callId}".`);
    }
    seen.add(request.callId);
  }
}
