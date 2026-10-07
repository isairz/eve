import { describe, expect, it, vi } from "vitest";
import type { EveProjectContext } from "#internal/project-context.js";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, interactiveAsker, withAnswers } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applyWebSetup, prepareWebSetup, type WebSetupDeps } from "./setup.js";

function deps(): WebSetupDeps {
  return {
    detectPackageManager: vi.fn<WebSetupDeps["detectPackageManager"]>(async () => ({
      kind: "pnpm",
      source: "lockfile",
    })),
    pathExists: vi.fn(async () => false),
    readTextFile: vi.fn(async () => '{"scripts":{"dev":"eve dev"}}\n'),
    resolveEveProjectContext: vi.fn(async (appRoot: string): Promise<EveProjectContext> => ({
      appRoot,
      environmentRoot: appRoot,
      kind: "standalone",
    })),
    writeTextFile: vi.fn(async () => {}),
    prepareWebAuthScaffold: vi.fn(async () => vi.fn(async () => {})),
    provisionWebChatAuth: vi.fn(async () => {}),
    installScaffoldDependencies: vi.fn(async () => {}),
  };
}

function contexts() {
  return createSetupContexts({
    appRoot: "/project",
    asker: headlessAsker(),
    environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
  });
}

/** Serves `files` from memory; every other path is absent. */
function withFiles(effects: WebSetupDeps, files: Record<string, string>) {
  vi.mocked(effects.pathExists).mockImplementation(async (path) => path in files);
  vi.mocked(effects.readTextFile).mockImplementation(async (path) => {
    const source = files[path];
    if (source === undefined) throw Object.assign(new Error(path), { code: "ENOENT" });
    return source;
  });
  effects.removeFile = vi.fn(async () => {});
  return effects;
}

const SERVICES_VERCEL_CONFIG = `import { withEve } from "eve/vercel";

export default await withEve({
  services: {
    web: {
      framework: "nextjs",
      root: "apps/web",
      buildCommand: "node ../../node_modules/next/dist/bin/next build",
    },
  },
  routes: [
    { src: "^(.*)$", destination: { type: "service", service: "web" } },
  ],
});
`;
const LEGACY_SERVICES_VERCEL_CONFIG = `import { withEve } from "eve/vercel";

export default await withEve({
  services: {
    web: { framework: "nextjs", root: "apps/web" },
  },
  routes: [
    { src: "^(.*)$", destination: { type: "service", service: "web" } },
  ],
});
`;

describe("Web setup", () => {
  it("presents the hosting topology with concise guidance", async () => {
    const effects = deps();
    const fake = createFakePrompter({
      single: (question) => (question.message.includes("sign in") ? "custom" : "vercel"),
    });
    const select = vi.spyOn(fake.prompter, "select");
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: interactiveAsker(fake.prompter),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: fake.prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });

    await prepareWebSetup(ctx.prepare, effects);

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How should Web Chat and your agents be deployed?",
        initialValue: "vercel",
        options: [
          {
            value: "vercel",
            label: "Vercel services",
            hint: "(Recommended) Web Chat and agents deploy as separate services.",
            featured: undefined,
          },
          {
            value: "next",
            label: "Next.js",
            hint: "One Next.js app serves Web Chat and routes agent requests.",
            featured: undefined,
          },
        ],
      }),
    );
  });

  it("does not require a Vercel project when Vercel services are selected", async () => {
    const effects = deps();
    const resolveVercelProject = vi.fn(async () => ({ orgId: "team", projectId: "project" }));
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: withAnswers({ "web-hosting": "vercel", "web-authentication": "custom" })(
        headlessAsker(),
      ),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject,
    });

    await expect(prepareWebSetup(ctx.prepare, effects)).resolves.toEqual({
      hosting: "vercel",
      packageManager: "pnpm",
    });
    expect(resolveVercelProject).not.toHaveBeenCalled();
  });

  it("does not require a Vercel project for other hosts", async () => {
    const effects = deps();
    const resolveVercelProject = vi.fn(async () => {
      throw new Error("eve link");
    });
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: withAnswers({ "web-hosting": "next", "web-authentication": "custom" })(
        headlessAsker(),
      ),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject,
    });

    await expect(prepareWebSetup(ctx.prepare, effects)).resolves.toEqual({
      hosting: "next",
      packageManager: "pnpm",
    });
    expect(resolveVercelProject).not.toHaveBeenCalled();
  });

  it("rejects an unselected workspace before writing an agent directory", async () => {
    const effects = deps();
    vi.mocked(effects.resolveEveProjectContext).mockResolvedValue({
      environmentRoot: "/project",
      kind: "workspace",
      workspace: {
        root: "/project",
        members: [{ appRoot: "/project/agents/support", name: "support" }],
      },
    });
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: headlessAsker(),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });

    await expect(
      applyWebSetup({ hosting: "vercel", packageManager: "pnpm" }, ctx.apply, effects),
    ).rejects.toThrow("Web Chat setup requires a selected workspace agent.");

    expect(effects.writeTextFile).not.toHaveBeenCalled();
  });

  it("writes the selected member channel and configures the workspace Web Chat target", async () => {
    const effects = deps();
    vi.mocked(effects.resolveEveProjectContext).mockResolvedValue({
      environmentRoot: "/project",
      kind: "workspace-member",
      member: { appRoot: "/project/agents/support", name: "support" },
      workspace: {
        root: "/project",
        members: [{ appRoot: "/project/agents/support", name: "support" }],
      },
    });
    const ctx = createSetupContexts({
      appRoot: "/project/agents/support",
      asker: headlessAsker(),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });
    await applyWebSetup({ hosting: "vercel", packageManager: "pnpm" }, ctx.apply, effects);

    expect(effects.writeTextFile).toHaveBeenNthCalledWith(
      1,
      "/project/agents/support/agent/channels/eve.ts",
      expect.any(String),
      { force: undefined },
    );
    expect(effects.writeTextFile).toHaveBeenNthCalledWith(
      2,
      "/project/apps/web/app/eve-agent.ts",
      expect.stringContaining('WEB_CHAT_AGENT: string | undefined = "support"'),
      { force: true },
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/vercel.ts",
      expect.stringContaining('root: "apps/web"'),
      { force: true },
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/package.json",
      expect.stringContaining('"dev": "eve dev"'),
      { force: true },
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/package.json",
      expect.stringContaining('"dev:all": "vercel dev --local"'),
      { force: true },
    );
  });

  it("preserves an authored default development script", async () => {
    const effects = deps();
    vi.mocked(effects.readTextFile).mockResolvedValue('{"scripts":{"dev":"custom-dev"}}\n');
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: headlessAsker(),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });

    await applyWebSetup({ hosting: "vercel", packageManager: "pnpm" }, ctx.apply, effects);

    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/package.json",
      expect.stringContaining('"dev": "custom-dev"'),
      { force: true },
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/package.json",
      expect.stringContaining('"dev:all": "vercel dev --local"'),
      { force: true },
    );
  });

  it("configures Vercel services for a standalone agent and returns the local command", async () => {
    const effects = deps();
    const fake = createFakePrompter();
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: headlessAsker(),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: fake.prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });
    await expect(
      applyWebSetup({ hosting: "vercel", packageManager: "npm" }, ctx.apply, effects),
    ).resolves.toEqual({
      facts: [{ label: "", value: "Start locally with `npm run dev:all`." }],
    });
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/eve.ts",
      expect.any(String),
      { force: undefined },
    );
    expect(effects.writeTextFile).toHaveBeenNthCalledWith(
      2,
      "/project/apps/web/app/eve-agent.ts",
      expect.stringContaining("WEB_CHAT_AGENT: string | undefined = undefined"),
      { force: true },
    );
    expect(effects.writeTextFile).toHaveBeenNthCalledWith(
      3,
      "/project/apps/web/next.config.ts",
      expect.stringContaining("export default nextConfig"),
      { force: true },
    );
    expect(fake.prompter.note).not.toHaveBeenCalled();
  });

  it("configures Next.js hosting for other platforms", async () => {
    const effects = deps();
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: headlessAsker(),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });

    await expect(
      applyWebSetup({ hosting: "next", packageManager: "yarn" }, ctx.apply, effects),
    ).resolves.toEqual({
      facts: [{ label: "", value: "Start locally with `yarn dev:web`." }],
    });
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/apps/web/next.config.ts",
      expect.stringContaining('fileURLToPath(new URL("../..", import.meta.url))'),
      { force: true },
    );
    expect(effects.writeTextFile).not.toHaveBeenCalledWith(
      "/project/vercel.ts",
      expect.anything(),
      expect.anything(),
    );
  });
  it("writes the Vercel services config byte for byte", async () => {
    const effects = deps();

    await applyWebSetup({ hosting: "vercel", packageManager: "pnpm" }, contexts().apply, effects);

    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/vercel.ts",
      SERVICES_VERCEL_CONFIG,
      { force: true },
    );
  });

  it.each([
    ["vercel", "/project/apps/web/next.config.ts"],
    ["next", "/project/apps/web/next.config.ts"],
    ["vercel", "/project/vercel.ts"],
  ] as const)(
    "refuses %s hosting over authored %s before writing anything",
    async (hosting, path) => {
      const effects = withFiles(deps(), { [path]: "export default {};\n" });

      await expect(
        applyWebSetup({ hosting, packageManager: "pnpm" }, contexts().apply, effects),
      ).rejects.toThrow(`${path} contains authored configuration`);
      expect(effects.writeTextFile).not.toHaveBeenCalled();
      expect(effects.removeFile).not.toHaveBeenCalled();
    },
  );

  it("leaves an authored vercel.ts alone for Next.js hosting", async () => {
    const effects = withFiles(deps(), { "/project/vercel.ts": "export default {};\n" });

    await applyWebSetup({ hosting: "next", packageManager: "pnpm" }, contexts().apply, effects);

    expect(effects.removeFile).not.toHaveBeenCalled();
    expect(effects.writeTextFile).not.toHaveBeenCalledWith(
      "/project/vercel.ts",
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([SERVICES_VERCEL_CONFIG, LEGACY_SERVICES_VERCEL_CONFIG])(
    "removes the installer's Vercel services config when switching to Next.js hosting",
    async (vercelConfig) => {
      const effects = withFiles(deps(), {
        "/project/vercel.ts": vercelConfig,
        "/project/package.json":
          '{"scripts":{"dev":"eve dev","dev:eve":"eve dev","dev:all":"vercel dev --local"}}\n',
      });

      await applyWebSetup({ hosting: "next", packageManager: "pnpm" }, contexts().apply, effects);

      expect(effects.removeFile).toHaveBeenCalledWith("/project/vercel.ts");
      expect(effects.writeTextFile).toHaveBeenCalledWith(
        "/project/package.json",
        `${JSON.stringify({ scripts: { dev: "eve dev" } }, null, 2)}\n`,
        { force: true },
      );
    },
  );

  it("resolves a project for sign-in and provisions it before installing auth", async () => {
    const effects = deps();
    const writeAuth = vi.fn(async () => {});
    vi.mocked(effects.prepareWebAuthScaffold).mockResolvedValue(writeAuth);
    const resolveVercelProject = vi.fn(async () => ({ orgId: "team", projectId: "project" }));
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: withAnswers({ "web-hosting": "vercel", "web-authentication": "vercel" })(
        headlessAsker(),
      ),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject,
    });
    const plan = await prepareWebSetup(ctx.prepare, effects);
    expect(resolveVercelProject).toHaveBeenCalledWith("Web Chat sign-in");
    await expect(applyWebSetup(plan, ctx.apply, effects)).resolves.toMatchObject({
      deploymentRequired: true,
    });
    expect(effects.provisionWebChatAuth).toHaveBeenCalledWith(
      { orgId: "team", projectId: "project" },
      undefined,
    );
    expect(writeAuth).toHaveBeenCalledOnce();
    expect(vi.mocked(effects.provisionWebChatAuth).mock.invocationCallOrder[0]).toBeLessThan(
      writeAuth.mock.invocationCallOrder[0]!,
    );
    expect(effects.installScaffoldDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/project" }),
    );
  });

  it("keeps auth files unchanged when provisioning fails", async () => {
    const effects = deps();
    const writeAuth = vi.fn(async () => {});
    vi.mocked(effects.prepareWebAuthScaffold).mockResolvedValue(writeAuth);
    vi.mocked(effects.provisionWebChatAuth).mockRejectedValue(new Error("Cannot create app"));
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: headlessAsker(),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });
    await expect(
      applyWebSetup(
        {
          hosting: "vercel",
          packageManager: "pnpm",
          authProject: { orgId: "team", projectId: "project" },
        },
        ctx.apply,
        effects,
      ),
    ).rejects.toThrow("Cannot create app");
    expect(writeAuth).not.toHaveBeenCalled();
    expect(effects.installScaffoldDependencies).not.toHaveBeenCalled();
  });
});
