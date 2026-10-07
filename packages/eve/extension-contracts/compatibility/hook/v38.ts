import { defineHook } from "#public/hooks/index.js";

// Epoch 38 stream events had no `history.imported`; epoch 39 adds it, which is additive.
export default defineHook({
  events: {
    "action.result"(event) {
      if (event.data.status === "failed") {
        console.info("call failed", { callId: event.data.result.callId });
      }
    },
    "authorization.required"(event, ctx) {
      console.info("sign-in required", { name: event.data.name, sessionId: ctx.session.id });
    },
  },
});
