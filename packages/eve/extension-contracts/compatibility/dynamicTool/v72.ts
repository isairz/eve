import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 72 `session.started` events and `ctx.session` had no `predecessor`;
// epoch 73 adds both.
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => ({
      session: defineTool({
        description: "Return the active session identifier.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ sessionId: ctx.session.id }),
      }),
    }),
  },
});
