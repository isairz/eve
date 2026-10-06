import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 32 `session.started` events and `ctx.session` had no `predecessor`;
// epoch 33 adds both.
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineSkill({
        description: "Triage the active incident.",
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
