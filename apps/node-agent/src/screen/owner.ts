import { z } from "zod";
import { helperInfoPath, SCREEN_TOKEN_HEADER } from "./helper.js";
import { inInteractiveSession, runningHelper, startHelperProcess } from "./view.js";

const PresenceSchema = z.object({ present: z.boolean() }).strict();

export function createOwnerPresenceReader(
  options: {
    env?: NodeJS.ProcessEnv;
    infoPath?: string;
    platform?: NodeJS.Platform;
    interactive?: () => Promise<boolean>;
    startHelper?: () => void;
  } = {},
): () => Promise<boolean> {
  const infoPath = options.infoPath ?? helperInfoPath(options.env);
  let started = false;
  return async () => {
    if ((options.platform ?? process.platform) !== "win32") return false;
    try {
      const helper = runningHelper(infoPath);
      if (helper === undefined) {
        if (!started && (await (options.interactive ?? inInteractiveSession)())) {
          started = true;
          (options.startHelper ?? startHelperProcess)();
        }
        return false;
      }
      started = false;
      const response = await fetch(`http://127.0.0.1:${helper.port}/presence`, {
        headers: { [SCREEN_TOKEN_HEADER]: helper.token },
        signal: AbortSignal.timeout(2_000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      return PresenceSchema.parse(await response.json()).present;
    } catch {
      return false;
    }
  };
}
