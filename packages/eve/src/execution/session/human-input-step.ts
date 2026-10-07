import {
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import {
  relaySessionEvents,
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import { applyTransition, sessionView } from "#harness/session-machine/commit.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { adaptHumanInput } from "#harness/hitl/index.js";
import { beforeStep, type BeforeStepArrival } from "#harness/hitl/index.js";
import { dispatchHumanInputEffects, effectHandlers } from "#harness/hitl/index.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

/** A durable session boundary: apply machine state before sending decision effects. */
export async function commitSessionStep(
  target: SessionStepState,
  arrivals: readonly BeforeStepArrival[],
): Promise<PublishedSessionEvents> {
  const session = readDurableSession(target.sessionState);
  const view = sessionView(storedProjection(session.state), session.state);
  const adapted = adaptHumanInput(view, beforeStep(view, arrivals));
  const events: UnstampedMessageStreamEvent[] = [];
  const applied = await applyTransition(session, adapted.transition, async (event) => {
    events.push(event);
  });
  const published = await relaySessionEvents(
    {
      ...target,
      sessionState: replaceDurableSessionSnapshot({ session: applied, state: target.sessionState }),
    },
    events,
  );
  const completions = await dispatchHumanInputEffects(adapted.effects, effectHandlers({}));
  if (completions.length !== 0)
    throw new TypeError("A parked relay effect cannot resume the model's authorization.");
  return published;
}
