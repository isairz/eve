import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 32 stream events had no `history.imported`; epoch 33 adds it, which is additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: `Review evidence for session ${ctx.session.id}.`,
        markdown: "# Evidence review\n\nCheck every claim against its source.",
      }),
  },
});
