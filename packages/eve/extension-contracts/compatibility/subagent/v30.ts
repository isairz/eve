import { defineAgent } from "#public/index.js";

// Epoch 30 `session.started` events had no `predecessor`; epoch 31 adds it.
export default defineAgent({
  description: "Research the incidents behind a metric change.",
  model: "openai/gpt-5.6-sol",
});
