import type { EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";

type SessionCursor = Pick<
  EveEvalSession,
  "pendingInputRequests" | "requireInputRequest" | "respondAll" | "sessionId" | "state"
>;

export async function waitForInput(
  t: EveEvalContext,
  initialSession: SessionCursor,
  toolName: string,
): Promise<SessionCursor> {
  let session = initialSession;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (session.pendingInputRequests.some((request) => request.action.toolName === toolName)) {
      session.requireInputRequest({ toolName });
      return session;
    }
    const live = watchNextTurn(t, session, "subagent input wait");
    const turn = await live.result();
    turn.noFailedActions();
    session = live.session;
  }
  throw new Error(`Subagent did not surface input for tool "${toolName}" after five turns.`);
}

export async function waitForMessage(
  t: EveEvalContext,
  initialSession: SessionCursor,
  marker: string,
): Promise<EveEvalTurn> {
  let session = initialSession;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const live = watchNextTurn(t, session, "subagent completion wait");
    const turn = await live.result();
    turn.noFailedActions();
    if (turn.message?.includes(marker) === true) return turn;
    session = live.session;
  }
  throw new Error(`Subagent result did not reach the parent after five turns.`);
}

function watchNextTurn(t: EveEvalContext, session: SessionCursor, operation: string) {
  if (session.sessionId === undefined || session.state === undefined) {
    throw new Error(`${operation} has no parent session cursor.`);
  }
  return t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex });
}
