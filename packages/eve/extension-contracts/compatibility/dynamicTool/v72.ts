import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 72 stream events had no `history.imported`; epoch 73 adds it, which is additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineTool({
        description: "Return the active session identifier.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ sessionId: ctx.session.id }),
      }),
  },
});
