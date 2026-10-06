import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { ApprovalCandidateOutcome } from "#protocol/message.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";
import type { SessionInboxAddress } from "#execution/session-inbox/address.js";

export type CandidateDecision = "approve" | "cancel";

/** Where a relayed request's answer goes. */
export interface RelayRoute {
  /** The child's continuation token, which names its session inbox unless `childSessionInbox` does. */
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  /** A remote agent's session, answered over its own protocol. */
  readonly remote?: RemoteAgentBinding & { readonly sessionId: string };
  /** Where in the child the batch came from; its fresh batch from one source replaces the last. */
  readonly inputSource?: string;
  /** The workflow run that relayed it: nobody can answer it once that run ends. */
  readonly runId?: string;
  /** The run's control hook, for its own `ctx.ask()` question. */
  readonly control?: string;
}

/** A candidate waiting on its policy, or on its responder's authorization. */
export interface ActiveCandidate {
  readonly candidateId: string;
  readonly createdAt: number;
  readonly decision: CandidateDecision;
  readonly expiresAt: number;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
  readonly status: "pending" | "authorization-required";
  /** The authorizations its policy waits on, while `authorization-required`. */
  readonly authorizations?: readonly AuthorizationChallenge[];
}

/** Who answered, narrowed to identity for the audit's finished records. */
export interface ResponderIdentity {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
}

export interface FinishedCandidate {
  readonly candidateId: string;
  readonly createdAt: number;
  readonly decision: CandidateDecision;
  readonly expiresAt: number;
  readonly reason?: string;
  readonly requestId: string;
  readonly responder: ResponderIdentity;
  readonly status: "allowed" | Exclude<ApprovalCandidateOutcome, "pending">;
}

/** An approval a signed-in person settled: through a candidate, or directly. */
export interface Settlement {
  readonly actor: ResponderIdentity;
  /** The full auth of the approver, absent for cancellations. */
  readonly approver?: SessionAuthContext;
  readonly candidateId?: string;
  readonly outcome: "allowed" | "cancelled";
  readonly requestId: string;
}

/** The durable candidate audit, kept in the session machine's execution state. */
export interface ApprovalAudit {
  readonly activeCandidates: Readonly<Record<string, ActiveCandidate>>;
  readonly candidateHistory: readonly FinishedCandidate[];
  readonly nextCandidateSequence: number;
  readonly settlements: Readonly<Record<string, Settlement>>;
}
