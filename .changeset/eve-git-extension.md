---
"eve": minor
---

GitHub work moves out of `eve/extensions/code` into a new built-in extension, `eve/extensions/git`. The code extension used to tell every agent that "GitHub credentials are not available to ordinary `bash`" and to route GitHub work through its `gh` tool, which only works with Connect-brokered `github` config. Agents whose shell already has `gh` credentials were steered to a tool that could not authenticate.

`git({})` adds the GitHub instructions and a `git__pr` skill that commits, pushes, and opens a draft with the shell's `gh pr create --draft`. `git({ github })` adds the Connect-brokered `git__gh` tool and switches `git__pr` to the signed-commit workflow. The tool and sandbox helpers are exported from `eve/extensions/git/tools` and `eve/extensions/git/sandbox`.

Deprecated: `code({ github })`. While it is set, the code extension still contributes `code__gh`, its GitHub instructions, and the signed-commit `code__pr` skill. Without it, `code({})` no longer contributes `code__gh`, `code__pr`, or any GitHub instructions; mount `eve/extensions/git` for the pull request skill. `gh` from `eve/extensions/code/tools` and the GitHub shell helpers from `eve/extensions/code/sandbox` still work but are deprecated.
