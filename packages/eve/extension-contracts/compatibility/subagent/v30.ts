import { defineAgent, defineDynamic } from "#public/index.js";

// Epoch 30 stream events had no `history.imported`; epoch 31 adds it, which is additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      ctx.session.auth.current === null
        ? null
        : defineAgent({
            description: "Investigate the authenticated user request.",
            model: "openai/gpt-5.6-sol",
          }),
  },
});
