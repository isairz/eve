import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 77 `ctx.session` had no `predecessor`, and `session.started` events had
// no `predecessor` data; epoch 78 adds both. Tools that read the session id keep working.
export default defineTool({
  description: "Look up the open tickets for the current conversation.",
  inputSchema: z.object({ queue: z.string() }),
  outputSchema: z.object({ queue: z.string(), sessionId: z.string() }),
  execute: ({ queue }, ctx) => ({ queue, sessionId: ctx.session.id }),
});
