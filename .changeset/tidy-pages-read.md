---
"eve": patch
---

Fix `web_fetch` conversion of HTML documents with a missing or empty Content-Type header. Markdown and text output now preserve readable content after large script sections instead of truncating raw HTML.
