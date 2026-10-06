---
"eve": patch
---

Add explicitly authorized, session-scoped JSON tool stubs with argument matching and response sequences that continue across turns within the same session. eve's internal workflow recovery preserves previously recorded tool results without consuming additional responses.

Rules use first-match-wins ordering and explicit slash-separated paths for local child tools. Grant replacement permission on individual `vercelOidc` subject entries or in a custom authenticator's result; existing sessions follow normal channel authentication.
