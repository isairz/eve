import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

const updates = defineChannel({
  routes: [],
  receive(input, { from }) {
    return from("daily-updates").send(input.message, { auth: input.auth });
  },
});

// Epoch 27 reads session streams with only a start index. Epoch 28 adds
// `follow` for bounded historical reads and `predecessor` to `session.started`.
export default defineSchedule({
  cron: "0 9 * * *",
  async run({ to, waitUntil, appAuth }) {
    const session = await to(updates, {}).send("Start the weekly digest.", { auth: appAuth });
    const events = await session.getEventStream({ startIndex: 0 });
    waitUntil(events.cancel());
  },
});
