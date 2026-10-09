import { join, resolve } from "node:path";

import { startHelper } from "../../node-agent/dist/screen/helper.js";

/**
 * The real screen helper with the fake ffmpeg behind it, for `mirror.test.mjs`:
 * `node screen-helper.fixture.mjs <info path> <ffmpeg log>`. Run as its own
 * process, as the at-logon task runs the real one, so the node finds it only
 * through the file it writes.
 */
const [infoPath, log] = process.argv.slice(2);
const fake = join(resolve(import.meta.dirname, "../../node-agent/dist/screen"), "fake-ffmpeg.js");

await startHelper({ ffmpeg: [process.execPath, fake, log], infoPath });
process.stdout.write("ready\n");
