import { join } from "node:path";

import { select } from "#setup/ask.js";
import type { RegistrySetupCompletion } from "#setup/registry-setup-protocol.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { installScaffoldDependencies } from "../shared/scaffold.js";
import { prepareWebAuthScaffold } from "./auth-scaffold.js";
import { WEB_AUTHENTICATION_QUESTION } from "./auth-options.js";
import { provisionWebChatAuth } from "./provision-auth.js";
import type { PackageManagerKind } from "#setup/package-manager.js";
import {
  defaultWebChatHostingDeps,
  peerServiceVercelConfig,
  prepareWebChatHosting,
  resolveWebChatProject,
  runScriptCommand,
  type WebChatHostingDeps,
} from "../web-chat/hosting.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

const NEXT_HOSTED_CONFIG = `import type { NextConfig } from "next";
import { withEve } from "eve/next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {};
const eveRoot = fileURLToPath(new URL("../..", import.meta.url));

export default withEve(nextConfig, { eveRoot });
`;
const PEER_SERVICE_NEXT_CONFIG = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
`;
const REGISTRY_NEXT_CONFIG = `import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {};

export default withEve(nextConfig);
`;
const PEER_SERVICE_VERCEL_CONFIG = peerServiceVercelConfig(
  "nextjs",
  "node ../../node_modules/next/dist/bin/next build",
);
const LEGACY_PEER_SERVICE_VERCEL_CONFIG = PEER_SERVICE_VERCEL_CONFIG.replace(
  /    web: \{[^}]+\},/,
  '    web: { framework: "nextjs", root: "apps/web" },',
);

export interface WebSetupDeps extends WebChatHostingDeps {
  prepareWebAuthScaffold: typeof prepareWebAuthScaffold;
  provisionWebChatAuth: typeof provisionWebChatAuth;
  installScaffoldDependencies: typeof installScaffoldDependencies;
}

const defaultWebSetupDeps: WebSetupDeps = {
  ...defaultWebChatHostingDeps,
  prepareWebAuthScaffold,
  provisionWebChatAuth,
  installScaffoldDependencies,
};

interface WebSetupPlan {
  hosting: "next" | "vercel";
  packageManager: PackageManagerKind;
  authProject?: VercelProjectReference;
  rootWebChat?: boolean;
}

export async function prepareWebSetup(
  context: SetupPrepareContext,
  deps: WebSetupDeps = defaultWebSetupDeps,
): Promise<WebSetupPlan> {
  const project = await resolveWebChatProject(context.appRoot, deps);
  const rootWebChat =
    (await deps.pathExists(join(project.environmentRoot, "app", "eve-agent.ts"))) &&
    !(await deps.pathExists(join(project.environmentRoot, "apps", "web", "app", "eve-agent.ts")));
  const hosting = rootWebChat
    ? "next"
    : await context.asker.ask(
        select({
          key: "web-hosting",
          message: "How should Web Chat and your agents be deployed?",
          options: [
            {
              id: "vercel",
              label: "Vercel services",
              hint: "(Recommended) Web Chat and agents deploy as separate services.",
              value: "vercel" as const,
            },
            {
              id: "next",
              label: "Next.js",
              hint: "One Next.js app serves Web Chat and routes agent requests.",
              value: "next" as const,
            },
          ],
          recommended: "vercel" as const,
          required: true,
        }),
      );
  const authentication = await context.asker.ask(WEB_AUTHENTICATION_QUESTION);
  const authProject =
    authentication === "vercel"
      ? await context.resolveVercelProject("Web Chat sign-in")
      : undefined;
  const plan: WebSetupPlan = {
    hosting,
    packageManager: (await deps.detectPackageManager(project.environmentRoot)).kind,
  };
  if (authProject !== undefined) plan.authProject = authProject;
  if (rootWebChat) plan.rootWebChat = true;
  return plan;
}

export async function applyWebSetup(
  plan: WebSetupPlan,
  context: SetupApplyContext,
  deps: WebSetupDeps = defaultWebSetupDeps,
) {
  const project = await resolveWebChatProject(context.appRoot, deps);
  const webRoot = plan.rootWebChat
    ? project.environmentRoot
    : join(project.environmentRoot, "apps", "web");
  const writeAuth =
    plan.authProject === undefined
      ? undefined
      : await deps.prepareWebAuthScaffold({
          environmentRoot: project.environmentRoot,
          agentAppRoot: project.agentAppRoot,
          webRoot,
          force: context.force,
        });
  const vercelServices = plan.hosting === "vercel";
  const hostedNextConfig = plan.rootWebChat ? REGISTRY_NEXT_CONFIG : NEXT_HOSTED_CONFIG;
  const hostedStartScript = plan.rootWebChat ? "dev" : "dev:web";
  const writeHosting = await prepareWebChatHosting(
    {
      project,
      webRoot,
      force: context.force,
      writeChannel: writeAuth === undefined,
      hostConfig: {
        path: join(webRoot, "next.config.ts"),
        source: vercelServices ? PEER_SERVICE_NEXT_CONFIG : hostedNextConfig,
        owned: [REGISTRY_NEXT_CONFIG, NEXT_HOSTED_CONFIG, PEER_SERVICE_NEXT_CONFIG],
      },
      vercelServices,
      vercelConfigs: [PEER_SERVICE_VERCEL_CONFIG, LEGACY_PEER_SERVICE_VERCEL_CONFIG],
    },
    deps,
  );
  await writeHosting();
  const startScript = vercelServices ? "dev:all" : hostedStartScript;
  if (plan.authProject !== undefined && writeAuth !== undefined) {
    await deps.provisionWebChatAuth(plan.authProject, context.signal);
    context.signal?.throwIfAborted();
    await writeAuth();
    await deps.installScaffoldDependencies({
      changed: true,
      log: context.presenter.log,
      projectPath: project.environmentRoot,
      signal: context.signal,
    });
    context.presenter.log.success("Configured Sign in with Vercel for this project's team");
    context.presenter.nextSteps([
      "Local setup is complete. Run `eve deploy` to publish these changes. Production and preview credentials are configured.",
      "Local development continues to use localDev() without signing in.",
    ]);
  }
  context.presenter.log.success("Configured channel: web");
  const completion: RegistrySetupCompletion = {
    facts: [
      {
        label: "",
        value: `Start locally with \`${runScriptCommand(plan.packageManager, startScript)}\`.`,
      },
    ],
  };
  if (plan.authProject !== undefined) completion.deploymentRequired = true;
  return completion;
}

export const WEB_SETUP = defineSetupIntegration({
  kind: "web",
  label: "Web Chat",
  hint: "Browser-based chat interface",
  prepare: prepareWebSetup,
  apply: applyWebSetup,
});
