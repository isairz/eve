import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

// Epoch 27 stream events had no `history.imported`; epoch 28 adds it, which is additive.
const updates = defineChannel({
  routes: [],
  events: {
    "authorization.required"(event) {
      console.info("sign-in required", { name: event.name });
    },
  },
  receive(input, { from }) {
    return from("daily-updates").send(input.message, { auth: input.auth });
  },
});

export default defineSchedule({
  cron: "0 9 * * *",
  async run({ to, appAuth }) {
    await to(updates, {}).send("Prepare the daily summary.", { auth: appAuth });
  },
});
