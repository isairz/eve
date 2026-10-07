---
"eve": patch
---

Remote-agent create requests now report that work may have completed when a successful response has an incompatible protocol or unreadable body. These failures stop automatic workflow retries, and protocol mismatches include the remote session ID for checking the outcome.
