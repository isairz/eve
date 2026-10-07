import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 33 stream events had no `history.imported`; epoch 34 adds it, which is additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: `Review evidence for session ${ctx.session.id}.` }),
  },
});
