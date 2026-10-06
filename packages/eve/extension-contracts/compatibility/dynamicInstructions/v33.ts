import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 33 `session.started` events and `ctx.session` had no `predecessor`;
// epoch 34 adds both.
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
