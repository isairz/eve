import type { Input } from "./input.js";

/**
 * When human input is committed: in the turn's step before its model call,
 * after it, or in the session steps around a parked turn.
 */
export type Phase = "pre-step" | "post-step" | "parked";

/** Input permissions by decision phase; these derive InputOf and backstop untyped callers. */
export const INPUT_PHASES = {
  "policy.checked": ["pre-step"],
  "authorization.resumed": ["pre-step"],
  "turn.waiting": ["pre-step", "post-step"],
  "approval.requested": ["post-step"],
  "authorization.required": ["post-step"],
  "actions.dispatched": ["post-step"],
  "budget.exceeded": ["pre-step"],
  "relayed.requested": ["parked"],
  "relayed.authorization": ["parked"],
  "input.answered": ["pre-step"],
  "message.received": ["pre-step"],
  "cancel.requested": ["pre-step", "post-step", "parked"],
  "authorization.completed": ["pre-step"],
  "actions.settled": ["post-step"],
  time: ["pre-step"],
  "budget.stopped": ["pre-step"],
  "run.ended": ["parked"],
  "delivery.received": ["parked"],
  "relayed.withdrawn": ["parked"],
  "context.cleared": ["pre-step"],
  "input.resumed": ["pre-step"],
  "cancel.replayed": ["pre-step"],
} as const satisfies { readonly [T in Input["type"]]: readonly Phase[] };

type In<Table extends Readonly<Record<string, readonly Phase[]>>, P extends Phase> = {
  [T in keyof Table]: P extends Table[T][number] ? T : never;
}[keyof Table];

/** What may be committed in phase `P`. */
export type InputOf<P extends Phase> = Extract<
  Input,
  { readonly type: In<typeof INPUT_PHASES, P> }
>;
