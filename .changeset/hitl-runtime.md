---
"eve": patch
---

Tool approvals, authorizations, budget questions, and relayed requests share one human-input lifecycle backed by the session machine. Approved calls run with the tools of the requesting step and are checked again before execution; model history no longer contains the AI SDK's approval parts.

Budget questions hold the turn open (`turn.waiting` with `on: "input"`) until Approve continues it or Stop cancels it, rather than completing the turn. Messages sent meanwhile wait until budget is granted. Late answers to closed requests become text for the model with the original prompt, tool name, and option label when available; closed budget answers are dropped instead.

Self-hosted sessions with legacy human-input state, coordination batches, approved-tool grants, or proxy input requests migrate once when loaded. The new machine state and removal of the old keys are committed together, preserving pending work and queued input.
