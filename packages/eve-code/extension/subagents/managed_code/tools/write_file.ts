import writeFile from "eve/tools/write_file";
import { withManagedGitAuth } from "../../../lib/managed-git-auth.ts";

export default withManagedGitAuth(writeFile);
