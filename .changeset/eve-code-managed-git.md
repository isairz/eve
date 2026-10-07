---
"eve": patch
---

Add an opt-in managed Git preview to `eve/extensions/code`. With `managedGit.enabled`, a `managed_code` subagent works in its own Vercel Sandbox checkout created from a Git source with Sandbox-managed Git credentials and signed pushes, authorized by the calling user's Vercel account. It is off by default.
