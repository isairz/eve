import { defineChannel, GET, POST } from "#public/channels/index.js";

// Epoch 51 reads session streams with only a start index and has no
// SessionStrandedError. Epoch 52 adds `follow` to getEventStream, throws
// SessionStrandedError from Session.send() for stranded sessions, and adds
// `predecessor` to `session.started` events.
export default defineChannel({
  routes: [
    GET("/stream/:sessionId", async (_request, { attachSession, describe, params }) => {
      const events = await attachSession(params.sessionId!).getEventStream({ startIndex: 0 });
      await events.cancel();
      return Response.json(await describe());
    }),
    POST("/threads/:threadId", async (request, { from, params }) => {
      const session = await from(params.threadId!).send(await request.text(), { auth: null });
      return Response.json({ sessionId: session.id });
    }),
  ],
});
