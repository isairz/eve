import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { waitForInput, waitForMessage } from "./subagent-approval";

// Different from the fixture executor's quote, so falling through cannot pass.
const STUBBED_PRICE = 314.15;

export default defineEval({
  tags: ["session-inbox", "stubs"],
  description:
    "A stubbed child tool still requires approval and returns its mock quote to the parent.",
  timeoutMs: 90_000,

  async test(t) {
    const session = await t.session({
      stubs: [
        {
          id: "goog-quote",
          tool: "stock-price/get_stock_price",
          match: { ticker: { const: "GOOG" } },
          response: {
            ticker: "GOOG",
            price: STUBBED_PRICE,
            change: 0,
            changePercent: "0.00%",
            currency: "USD",
          },
        },
      ],
    });
    const started = await session.send(
      `Call the stock-price subagent exactly once with message 'Call the get_stock_price tool exactly once with ticker "GOOG". After it returns, do not call any tool again; return the result.'. After that single subagent call finishes, do not call any subagent or tool again; include the exact stock price in your final reply.`,
    );
    const blocked = await waitForInput(t, started.session, "get_stock_price");
    session.notEvent("task.settled", { data: { name: "stock-price", status: "completed" } });

    const resumed = await blocked.respondAll("approve");
    t.check(resumed.inputRequests, equals([]));
    resumed.noFailedActions();
    const price = String(STUBBED_PRICE);
    const completed = resumed.message?.includes(price)
      ? resumed
      : await waitForMessage(t, resumed.session, price);
    completed.messageIncludes(price);

    t.succeeded();
    t.calledSubagent("stock-price", { status: "completed", count: 1 });
    t.noFailedActions();
  },
});
