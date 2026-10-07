import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 40 stream events had no `history.imported`; epoch 41 adds it, which is additive.
export default defineMcpClientConnection({
  description: "The specialist agent's tools.",
  url: "https://specialist.example.com/eve/v1/mcp",
  headers: { authorization: "Bearer specialist-token" },
  protocolVersionDiscovery: false,
});
