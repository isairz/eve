import readFile from "eve/tools/read_file";
import { withManagedGitAuth } from "../../../lib/managed-git-auth.ts";

export default withManagedGitAuth(readFile);
