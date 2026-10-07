---
"eve": patch
---

Add explicitly authorized, session-scoped JSON tool stubs with argument matching and outcome sequences that continue across turns within the same session. Each rule specifies `outcome` or nonempty `outcomes`, with a JSON `response` in each outcome; eve's internal workflow recovery reuses recorded outcomes without consuming another entry.

Rules use first-match-wins ordering and explicit slash-separated paths for local child tools. Grant replacement permission on individual `vercelOidc` subject entries or in a custom authenticator's result; existing sessions follow normal channel authentication.

Invalid static tool paths and unsupported matcher features fail session creation. Unused rules produce eval warnings. Deployment handoffs use a new checkpoint version for all sessions, so sessions cannot hand off to deployments running an older version.
