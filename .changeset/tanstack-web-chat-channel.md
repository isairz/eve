---
"eve": patch
---

Add `eve add channel/tanstack`, which installs a Web Chat app for TanStack Start under `apps/web/`. It can deploy as a separate Vercel service or run inside the TanStack Start app through `eve/tanstack`. Both Web Chat installers now check for authored configuration before writing files, and switching hosting modes removes the `vercel.ts` and scripts written for the other mode. Web Chat's sans-serif and monospace text now renders in the loaded Geist fonts.
