import { defineState } from "#public/context/index.js";

// Epoch 9 session context had no `session.predecessor`; epoch 10 adds it.
// State handles are unchanged.
export const visits = defineState("compatibility.visits", () => ({ count: 0 }));

export function recordVisit(): number {
  visits.update((current) => ({ count: current.count + 1 }));
  return visits.get().count;
}
