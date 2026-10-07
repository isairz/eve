import { defineExtension } from "eve/extension";
import type { SandboxSession } from "eve/sandbox";
import type { ToolAuthProvider } from "eve/tools";
import { z } from "zod";

import type { GitHubConfig } from "eve/extensions/git/sandbox";

import type { ManagedGitSettings } from "./lib/managed-git-auth.ts";

export type CredentialPolicyBroker = (
  sandbox: SandboxSession,
  rules: Record<string, Record<string, string>>,
) => Promise<void>;

export type { GitHubLeaseRule } from "eve/extensions/git/sandbox";

export type GitHubLeaseBroker = GitHubConfig["broker"];

const fn = <T>() => z.custom<T>((value) => typeof value === "function");
const delivery = z.enum(["firewall", "command"]).default("firewall");
const reasoning = z.enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"]);
const openaiReasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export default defineExtension({
  config: z.object({
    managedGit: z
      .object({
        enabled: z.boolean().default(false),
        /** User-scoped Vercel authorization, e.g. `connect()` from `@vercel/connect/eve`. */
        auth: z.custom<ToolAuthProvider>((value) => typeof value === "object" && value !== null),
        resolveOptions: fn<() => ManagedGitSettings | Promise<ManagedGitSettings>>(),
      })
      .optional(),
    /**
     * @deprecated Mount `eve/extensions/git` with this `github` config instead.
     * While set, this extension still contributes the authenticated `gh` tool,
     * its instructions, and the signed-commit `pr` skill.
     */
    github: z
      .object({
        connector: z.string().min(1),
        org: z.string().min(1),
        broker: fn<GitHubLeaseBroker>(),
      })
      .optional(),
    vercel: z
      .object({
        connector: z.string().min(1),
        delivery,
      })
      .optional(),
    broker: fn<CredentialPolicyBroker>().optional(),
    worker: z
      .object({
        model: z.string().min(1),
        reasoning,
        openaiReasoningEffort: openaiReasoningEffort.optional(),
      })
      .optional(),
  }),
});
