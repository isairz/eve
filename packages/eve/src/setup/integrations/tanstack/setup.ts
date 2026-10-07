import { join } from "node:path";

import { select } from "#setup/ask.js";
import type { PackageManagerKind } from "#setup/package-manager.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";
import {
  defaultWebChatHostingDeps,
  peerServiceVercelConfig,
  prepareWebChatHosting,
  resolveWebChatProject,
  runScriptCommand,
  type WebChatHostingDeps,
} from "../web-chat/hosting.js";

/** The `vite.config.ts` the `channel/tanstack` registry item installs. */
export const TANSTACK_REGISTRY_VITE_CONFIG = `import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [tailwindcss(), tanstackStart({ srcDirectory: "app" }), viteReact(), nitro()],
});
`;
const TANSTACK_HOSTED_VITE_CONFIG = `import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { eveTanStack } from "eve/tanstack";
import { nitro } from "nitro/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const eveRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    eveTanStack({ eveRoot }),
    tailwindcss(),
    tanstackStart({ srcDirectory: "app" }),
    viteReact(),
    nitro(),
  ],
});
`;
const PEER_SERVICE_VERCEL_CONFIG = peerServiceVercelConfig(
  "tanstack-start",
  "node ../../node_modules/vite/bin/vite.js build",
);

interface TanStackSetupPlan {
  hosting: "tanstack" | "vercel";
  packageManager: PackageManagerKind;
}

export async function prepareTanStackSetup(
  context: SetupPrepareContext,
  deps: WebChatHostingDeps = defaultWebChatHostingDeps,
): Promise<TanStackSetupPlan> {
  const project = await resolveWebChatProject(context.appRoot, deps);
  // `eveTanStack()` mounts one agent, so a workspace member deploys as a peer service.
  const hosting =
    project.agentName !== undefined
      ? ("vercel" as const)
      : await context.asker.ask(
          select({
            key: "tanstack-hosting",
            message: "How should Web Chat and your agent be deployed?",
            options: [
              {
                id: "vercel",
                label: "Vercel services",
                hint: "(Recommended) Web Chat and the agent deploy as separate services.",
                value: "vercel" as const,
              },
              {
                id: "tanstack",
                label: "TanStack Start",
                hint: "One TanStack Start app serves Web Chat and routes agent requests.",
                value: "tanstack" as const,
              },
            ],
            recommended: "vercel" as const,
            required: true,
          }),
        );
  return {
    hosting,
    packageManager: (await deps.detectPackageManager(project.environmentRoot)).kind,
  };
}

export async function applyTanStackSetup(
  plan: TanStackSetupPlan,
  context: SetupApplyContext,
  deps: WebChatHostingDeps = defaultWebChatHostingDeps,
) {
  const project = await resolveWebChatProject(context.appRoot, deps);
  const webRoot = join(project.environmentRoot, "apps", "web");
  const vercelServices = plan.hosting === "vercel";
  const writeHosting = await prepareWebChatHosting(
    {
      project,
      webRoot,
      force: context.force,
      writeChannel: true,
      hostConfig: {
        path: join(webRoot, "vite.config.ts"),
        source: vercelServices ? TANSTACK_REGISTRY_VITE_CONFIG : TANSTACK_HOSTED_VITE_CONFIG,
        owned: [TANSTACK_REGISTRY_VITE_CONFIG, TANSTACK_HOSTED_VITE_CONFIG],
      },
      vercelServices,
      vercelConfigs: [PEER_SERVICE_VERCEL_CONFIG],
    },
    deps,
  );
  await writeHosting();
  const startScript = vercelServices ? "dev:all" : "dev:web";
  context.presenter.log.success("Configured channel: tanstack");
  return {
    facts: [
      {
        label: "",
        value: `Start locally with \`${runScriptCommand(plan.packageManager, startScript)}\`.`,
      },
    ],
  };
}

export const TANSTACK_SETUP = defineSetupIntegration({
  kind: "tanstack",
  label: "Web Chat (TanStack Start)",
  hint: "Browser-based chat interface in a TanStack Start app",
  prepare: prepareTanStackSetup,
  apply: applyTanStackSetup,
});
