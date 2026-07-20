// Compatibility shim for earlier Green Arrow branded integrations.
// New code should import the Xiaowei-named transport/client modules directly.
export {
  normalizeXiaoweiResponse,
  sendXiaoweiRequest,
  validateXiaoweiEndpoint,
  XiaoweiTransportError,
} from "./xiaowei-transport.mjs";

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runXiaoweiCli } from "./xiaowei-api.mjs";

export { runXiaoweiCli };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runXiaoweiCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
