import bash from "eve/tools/bash";
import { withManagedGitAuth } from "../../../lib/managed-git-auth.ts";

export default withManagedGitAuth(bash);
