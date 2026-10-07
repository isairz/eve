import { defineSandbox } from "eve/sandbox";

import extension from "../../extension.ts";
import { managedGitEnvironment, managedGitImplementation } from "../../lib/managed-git-sandbox.ts";
import { currentManagedGitAuth } from "../../lib/managed-git-auth.ts";
import { withDevboxCredentials } from "../../lib/devbox-credentials.ts";

// No template: each child must receive its own managed Git grant at creation.
export const environment = managedGitEnvironment(() =>
  withDevboxCredentials(managedGitImplementation(resolveAuth), resolveAuth),
);

export default defineSandbox(() => environment.open());

function resolveAuth() {
  const config = extension.config.managedGit;
  if (config?.enabled !== true) throw new Error("Managed Git sandbox is disabled.");
  return currentManagedGitAuth();
}
