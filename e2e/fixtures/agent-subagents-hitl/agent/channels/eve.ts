import { localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  // Allow authenticated eval callers to supply data in this isolated fixture.
  auth: [vercelOidc(), localDev()].map((authenticate) => async (request) => {
    const auth = await authenticate(request);
    return auth ? { ...auth, allowToolStubs: true } : null;
  }),
});
