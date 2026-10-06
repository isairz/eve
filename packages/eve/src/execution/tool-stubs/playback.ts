import { createHook } from "#compiled/@workflow/core/index.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import { StubPlayback } from "#tool-stubs/rules.js";
import {
  failStubSessionStep,
  publishStubFailureStep,
  publishStubResultStep,
} from "#execution/tool-stubs/steps.js";
import { STUB_CONTEXT_KEY, type StubCall, type StubScope } from "#tool-stubs/types.js";

export type StubRequest =
  | { readonly kind: "call"; readonly call: StubCall }
  | { readonly kind: "failure"; readonly callId: string; readonly error: string };

/** The original workflow keeps this hook even while a successor owns its turns. */
export async function withStubPlayback<T>(
  context: Record<string, unknown>,
  sessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const scope = context[STUB_CONTEXT_KEY] as StubScope | undefined;
  if (scope === undefined || scope.rootSessionId !== undefined) return await run();
  context[STUB_CONTEXT_KEY] = { ...scope, rootSessionId: sessionId };
  let playback: StubPlayback;
  try {
    playback = new StubPlayback(scope.rules);
  } catch (error) {
    await publishStubFailureStep(
      error instanceof Error ? error.message : "Could not compile tool stub matchers.",
    );
    throw error;
  }
  const hook = createHook<StubRequest>({ token: scope.token });
  let failed = false;
  const serve = async (): Promise<never> => {
    for await (const request of hook) {
      const result =
        request.kind === "failure"
          ? playback.fail(request.callId, request.error)
          : playback.call(request.call);
      if (result.kind === "error" && !failed) {
        // Step completion makes the failure durable before the separate response stream.
        await publishStubFailureStep(result.error);
        failed = true;
      }
      await publishStubResultStep({
        callId: request.kind === "call" ? request.call.callId : `${request.callId}:failure`,
        result,
      });
    }
    throw new Error("Tool stub playback ended before its session.");
  };
  try {
    await claimHookOwnership(hook);
    const running = run();
    const serving = serve().catch(async () => {
      await publishStubFailureStep("Tool stub playback failed.");
      // Fail the current owner through its inbox, aborting its active turn before
      // finalization. The owner may have moved to another workflow deployment.
      await failStubSessionStep(sessionId);
      return await running;
    });
    return await Promise.race([running, serving]);
  } finally {
    await disposeHook(hook);
  }
}
