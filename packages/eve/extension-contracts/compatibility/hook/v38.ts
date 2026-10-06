import { defineHook } from "#public/hooks/index.js";

// Epoch 38 `session.started` events and `ctx.session` had no `predecessor`;
// epoch 39 adds both. Hooks that read only the session id keep working.
export default defineHook({
  events: {
    "session.started"(_event, ctx) {
      console.info("session started", { sessionId: ctx.session.id });
    },
  },
});
