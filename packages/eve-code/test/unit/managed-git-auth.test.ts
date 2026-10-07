import assert from "node:assert/strict";
import test from "node:test";
import type { ToolAuthProvider, ToolContext } from "eve/tools";

import {
  currentManagedGitAuth,
  getManagedGitSandbox,
} from "../../extension/lib/managed-git-auth.ts";
import { managedGitImplementation } from "../../extension/lib/managed-git-sandbox.ts";

const vercelAuth = {
  principalType: "user",
  async getToken() {
    return { token: "unused" };
  },
} as unknown as ToolAuthProvider;

const settings = {
  auth: vercelAuth,
  repository: "https://github.com/vercel/internal-agents",
  teamId: "team_test",
  projectId: "prj_test",
};

function fixture(id = "alice") {
  let saved: { caller: string; vercelUserId: string } | null = null;
  const state = {
    get: () => saved,
    update: (fn: (value: typeof saved) => typeof saved) => {
      saved = fn(saved);
    },
  };
  const calls: string[] = [];
  const ctx = {
    session: { auth: { current: { principalId: id, principalType: "user", issuer: "slack:T" } } },
    abortSignal: new AbortController().signal,
    async getToken(provider: unknown) {
      assert.equal(provider, vercelAuth);
      calls.push("authorize");
      return { token: `token-${id}` };
    },
    requireAuth() {
      throw new Error("consent required");
    },
    async getSandbox() {
      calls.push("sandbox");
      const auth = currentManagedGitAuth();
      assert.equal(auth.token, `token-${id}`);
      assert.deepEqual(auth.commitAs, { name: id, email: `${id}@example.com` });
      assert.equal(auth.projectId, settings.projectId);
      await Promise.resolve();
      assert.equal(currentManagedGitAuth().token, `token-${id}`);
      return { id: `sbx-${id}` };
    },
  } as unknown as ToolContext;
  const send = (async (input, init) => {
    assert.equal(input, "https://api.vercel.com/login/oauth/userinfo");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer token-${id}`);
    calls.push("identity");
    return Response.json({
      sub: `vercel-${id}`,
      name: id,
      preferred_username: id,
      email: `${id}@example.com`,
    });
  }) satisfies typeof fetch;
  return { ctx, state, send, calls };
}

test("user authorization and verified identity precede sandbox creation; only ownership is saved", async () => {
  const f = fixture();
  await getManagedGitSandbox(f.ctx, settings, f.state, f.send);
  assert.deepEqual(f.calls, ["authorize", "identity", "sandbox"]);
  assert.deepEqual(f.state.get(), { caller: '["slack:T","alice"]', vercelUserId: "vercel-alice" });
  assert.throws(currentManagedGitAuth, /Authorize Vercel/);
  f.calls.length = 0;
  await getManagedGitSandbox(f.ctx, settings, f.state, f.send);
  assert.deepEqual(f.calls, ["authorize", "identity", "sandbox"]);
});

test("consent challenges and anonymous callers cannot create a sandbox", async () => {
  const f = fixture();
  const challenge = new Error("consent required");
  f.ctx.getToken = async () => {
    throw challenge;
  };
  await assert.rejects(
    getManagedGitSandbox(f.ctx, settings, f.state, f.send),
    (error) => error === challenge,
  );
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.get(), null);
  const anonymous = {
    ...f.ctx,
    session: { ...f.ctx.session, auth: { current: null, initiator: null } },
  };
  await assert.rejects(
    getManagedGitSandbox(anonymous, settings, f.state, f.send),
    /authenticated user/,
  );
});

test("expired tokens require consent again before sandbox access", async () => {
  const f = fixture();
  await assert.rejects(
    getManagedGitSandbox(f.ctx, settings, f.state, async () => new Response(null, { status: 401 })),
    /consent required/,
  );
  assert.deepEqual(f.calls, ["authorize"]);
  assert.equal(f.state.get(), null);
});

test("another caller or another Vercel account cannot reuse the sandbox", async () => {
  const alice = fixture();
  await getManagedGitSandbox(alice.ctx, settings, alice.state, alice.send);
  const bob = fixture("bob");
  await assert.rejects(
    getManagedGitSandbox(bob.ctx, settings, alice.state, bob.send),
    /another user/,
  );
  assert.deepEqual(bob.calls, []);
  alice.calls.length = 0;
  await assert.rejects(
    getManagedGitSandbox(alice.ctx, settings, alice.state, async () =>
      Response.json({ sub: "vercel-bob", preferred_username: "bob", email: "bob@example.com" }),
    ),
    /another Vercel account/,
  );
  assert.deepEqual(alice.calls, ["authorize"]);
});

test("concurrent users have isolated creation credentials", async () => {
  const alice = fixture();
  const bob = fixture("bob");
  await Promise.all([
    getManagedGitSandbox(alice.ctx, settings, alice.state, alice.send),
    getManagedGitSandbox(bob.ctx, settings, bob.state, bob.send),
  ]);
  assert.notDeepEqual(alice.state.get(), bob.state.get());
  assert.throws(currentManagedGitAuth, /Authorize Vercel/);
});

test("identity lookup errors never reach the sandbox or expose the response body", async () => {
  const f = fixture();
  await assert.rejects(
    getManagedGitSandbox(
      f.ctx,
      settings,
      f.state,
      async () => new Response("private provider error", { status: 403 }),
    ),
    { message: "Vercel account lookup failed (403)." },
  );
  assert.deepEqual(f.calls, ["authorize"]);
});

test("the caller's OAuth token and verified identity reach the real Sandbox SDK request", async () => {
  const f = fixture();
  let creates = 0;
  const provider = managedGitImplementation(() => ({
    ...currentManagedGitAuth(),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(request.headers.get("authorization"), "Bearer token-alice");
      if (request.method === "GET") {
        return Response.json({ error: { message: "Not found" } }, { status: 404 });
      }
      creates++;
      const body = await request.json();
      assert.equal(body.projectId, settings.projectId);
      assert.deepEqual(body.source, { type: "git", url: settings.repository, credentials: true });
      assert.deepEqual(body.commitAs, { name: "alice", email: "alice@example.com" });
      return Response.json({ error: { message: "Preview disabled" } }, { status: 400 });
    },
  }));
  f.ctx.getSandbox = async () => {
    const { handle } = await provider.start(
      {
        host: {} as never,
        session: {
          auth: { current: null, initiator: null },
          id: "oauth-managed-check",
          turn: { id: "turn", sequence: 0 },
        },
        storagePath: "/unused",
      },
      undefined,
      {},
    );
    return handle.sandbox as never;
  };
  await assert.rejects(getManagedGitSandbox(f.ctx, settings, f.state, f.send), /Preview disabled/);
  assert.equal(creates, 1);
  assert.throws(currentManagedGitAuth, /Authorize Vercel/);
});
