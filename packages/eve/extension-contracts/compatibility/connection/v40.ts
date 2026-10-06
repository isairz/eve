import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 40 `session.started` events and session context had no `predecessor`;
// epoch 41 adds both.
export default defineMcpClientConnection({
  description: "Search the incident tracker.",
  url: "https://incidents.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
