import type { SandboxEnvironment, SandboxSession } from "eve/sandbox";
import {
  defineSandboxProvider,
  type SandboxPreparedArtifact,
  type SandboxProviderImplementation,
} from "eve/sandbox/provider";
import { VercelSandbox, type VercelSandboxEnvironmentOptions } from "eve/sandbox/vercel";

export const MANAGED_GIT_PROVIDER = "eve-code-managed-git";

export interface ManagedGitSandboxOptions {
  /** Off by default. The consumer evaluates its feature flag before calling. */
  readonly enabled?: boolean;
  /** HTTPS URL of the GitHub repository authorized by the project's Git Bound. */
  readonly repository: string;
  readonly revision?: string;
  readonly commitAs: { readonly name: string; readonly email: string };
  /** A user-scoped Vercel token; project OIDC cannot authorize managed Git. */
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly timeout?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Session state of the wrapped Vercel provider, plus adapter fields. */
export type ManagedGitSessionState = {
  readonly sandboxName: string;
  readonly version: 3;
  readonly devboxId?: string;
};

export type ManagedGitArtifact = { readonly [key: string]: SandboxPreparedArtifact };

export type ManagedGitImplementation = SandboxProviderImplementation<
  undefined,
  ManagedGitArtifact,
  ManagedGitSessionState,
  SandboxSession
>;

type ResolveOptions = () => ManagedGitSandboxOptions | Promise<ManagedGitSandboxOptions>;

/**
 * A template-free Vercel provider. Credentials are resolved only when a session
 * starts or resumes, never during preparation, so every fresh sandbox is created
 * from a Git source with its own managed Git grant.
 */
export function managedGitImplementation(resolveOptions: ResolveOptions): ManagedGitImplementation {
  async function vercel() {
    const options = await resolveOptions();
    if (options.enabled !== true) throw new Error("Managed Git sandbox is disabled.");
    return vercelImplementation(managedGitCreateOptions(options));
  }
  return {
    async prepare(context) {
      const { skills, workspace } = context.resources;
      if ((skills?.files.length ?? 0) > 0 || (workspace?.files.length ?? 0) > 0) {
        throw new Error(
          "Managed Git sandboxes cannot inherit template credentials. Keep this agent free of skills and workspace seeds.",
        );
      }
      return {};
    },
    async start(context) {
      const { handle, state } = await (await vercel()).start(context, undefined, {});
      return { handle, state: requireState(state) };
    },
    async resume(context, _artifact, state) {
      // Resume reconnects the named sandbox; it never recreates a Git grant.
      return await (await vercel()).resume(context, {}, requireState(state));
    },
  };
}

/** The `eve/sandbox/provider` environment for the managed coding subagent. */
export function managedGitEnvironment(
  implementation: () => ManagedGitImplementation,
): SandboxEnvironment<undefined, SandboxSession> {
  return defineSandboxProvider<
    undefined,
    undefined,
    ManagedGitArtifact,
    ManagedGitSessionState,
    SandboxSession
  >({ name: MANAGED_GIT_PROVIDER, environment: implementation }).environment();
}

export function requireState(state: unknown): ManagedGitSessionState {
  if (typeof state !== "object" || state === null) {
    throw new Error("Invalid managed Git sandbox state.");
  }
  const { sandboxName, version, devboxId } = state as Record<string, unknown>;
  if (typeof sandboxName !== "string" || version !== 3) {
    throw new Error("Invalid managed Git sandbox state.");
  }
  if (devboxId !== undefined && typeof devboxId !== "string") {
    throw new Error("Invalid persisted Devbox identity.");
  }
  return devboxId === undefined ? { sandboxName, version } : { sandboxName, version, devboxId };
}

type VercelImplementation = SandboxProviderImplementation<
  undefined,
  SandboxPreparedArtifact,
  SandboxPreparedArtifact,
  SandboxSession
>;

/**
 * Eve's Vercel provider is only reachable through its environment, whose options
 * are fixed when the module loads. The managed grant needs the caller's token, so
 * build a per-call environment and drive its implementation directly. The
 * artifact is always `{}` (no snapshot), so `source` reaches sandbox creation.
 */
function vercelImplementation(options: VercelSandboxEnvironmentOptions): VercelImplementation {
  const environment = VercelSandbox.environment(options);
  const runtime: unknown = Reflect.get(environment, Symbol.for("eve.sandbox-provider-runtime"));
  const implementation =
    typeof runtime === "object" && runtime !== null
      ? (Reflect.get(runtime, "implementation") as VercelImplementation | undefined)
      : undefined;
  if (typeof implementation?.start !== "function" || typeof implementation.resume !== "function") {
    throw new Error("This eve version does not expose the Vercel sandbox provider.");
  }
  return implementation;
}

function managedGitCreateOptions(
  options: ManagedGitSandboxOptions,
): VercelSandboxEnvironmentOptions {
  const repository = new URL(options.repository);
  if (
    repository.protocol !== "https:" ||
    repository.host !== "github.com" ||
    repository.username ||
    repository.password ||
    repository.search ||
    repository.hash ||
    !/^\/[^/]+\/[^/]+\/?$/.test(repository.pathname)
  ) {
    throw new Error("Managed Git requires an HTTPS GitHub repository URL without credentials.");
  }
  if (!options.token.trim() || !options.teamId.trim() || !options.projectId.trim()) {
    throw new Error("Managed Git requires a user token, teamId, and projectId.");
  }
  if (!options.commitAs.name.trim() || !options.commitAs.email.trim()) {
    throw new Error("Managed Git requires a commit name and email.");
  }

  const send = options.fetch ?? globalThis.fetch;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "POST" || !/^\/(?:api\/)?v[23]\/sandboxes$/.test(url.pathname)) {
      return send(request);
    }
    const body = (await request.json()) as { readonly source?: object };
    // The pinned SDK drops commitAs and does not type source.credentials yet.
    // Add the preview API fields only to the sandbox creation request.
    return send(
      new Request(request, {
        method: "POST",
        body: JSON.stringify({
          ...body,
          source: { ...body.source, credentials: true },
          commitAs: options.commitAs,
        }),
      }),
    );
  };
  return {
    token: options.token,
    teamId: options.teamId,
    projectId: options.projectId,
    source: { type: "git", url: repository.href, revision: options.revision },
    timeout: options.timeout,
    fetch,
  } as VercelSandboxEnvironmentOptions;
}
