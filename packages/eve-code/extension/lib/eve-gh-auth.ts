import { AsyncLocalStorage } from "node:async_hooks";
import { defineState, type StateHandle } from "eve/context";
import {
  defineTool,
  type ToolAuthProvider,
  type ToolContext,
  type ToolDefinition,
} from "eve/tools";
import { z } from "zod";

import extension from "../extension.ts";
import type { EveGhSandboxOptions } from "./eve-gh-sandbox.ts";

export interface EveGhSettings {
  readonly repository: string;
  readonly revision?: string;
  readonly teamId: string;
  readonly projectId: string;
}

interface Owner {
  readonly caller: string;
  readonly vercelUserId: string;
}

const owner = defineState<Owner | null>("eve-code.eve-gh-owner", () => null);
const creationAuth = new AsyncLocalStorage<EveGhSandboxOptions>();
const userSchema = z.object({
  sub: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  preferred_username: z.string().trim().min(1),
  email: z.email(),
});

export function currentEveGhAuth(): EveGhSandboxOptions {
  const options = creationAuth.getStore();
  if (!options)
    throw new Error("Authorize Vercel through an eve-gh tool before opening the sandbox.");
  return options;
}

/**
 * Settings plus the user-scoped Vercel authorization. The provider comes from the
 * consumer (for example `connect()` from `@vercel/connect/eve`): eve compiles this
 * extension and cannot import that adapter itself.
 */
export interface EveGhAccess extends EveGhSettings {
  readonly auth: ToolAuthProvider;
}

export async function getEveGhSandbox(
  ctx: ToolContext,
  access: EveGhAccess,
  ownership: StateHandle<Owner | null> = owner,
  send: typeof fetch = globalThis.fetch,
) {
  const principal = ctx.session.auth.current;
  if (principal?.principalType !== "user") {
    throw new Error("eve-gh requires an authenticated user.");
  }
  const caller = JSON.stringify([principal.issuer ?? null, principal.principalId]);
  if (ownership.get() !== null && ownership.get()?.caller !== caller) {
    throw new Error("This eve-gh sandbox belongs to another user. Start a new coding session.");
  }
  const { auth: provider, ...settings } = access;
  const { token } = await ctx.getToken(provider);
  const response = await send("https://api.vercel.com/login/oauth/userinfo", {
    headers: { authorization: `Bearer ${token}` },
    signal: ctx.abortSignal,
  });
  if (response.status === 401) ctx.requireAuth(provider);
  if (!response.ok) throw new Error(`Vercel account lookup failed (${response.status}).`);
  const user = userSchema.parse(await response.json());
  ownership.update((previous) => {
    if (previous && (previous.caller !== caller || previous.vercelUserId !== user.sub)) {
      throw new Error(
        "This eve-gh sandbox belongs to another Vercel account. Start a new coding session.",
      );
    }
    return { caller, vercelUserId: user.sub };
  });

  // Only nonsecret ownership is authored state. Pass the current user's token
  // to Eve's backend in this async scope, never in config, tool output, or VM files.
  return creationAuth.run(
    {
      ...settings,
      enabled: true,
      token,
      commitAs: { name: user.name ?? user.preferred_username, email: user.email },
    },
    () => ctx.getSandbox(),
  );
}

export function withEveGhAuth<I, O>(tool: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return defineTool({
    ...tool,
    execute(input, ctx) {
      return tool.execute(input, {
        ...ctx,
        async getSandbox() {
          const config = extension.config.eveGh;
          if (config?.enabled !== true) throw new Error("eve-gh sandbox is disabled.");
          return getEveGhSandbox(ctx, {
            ...(await config.resolveOptions()),
            auth: config.auth,
          });
        },
      });
    },
  });
}
