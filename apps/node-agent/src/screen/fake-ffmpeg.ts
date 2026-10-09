import { existsSync, writeFileSync } from "node:fs";

/**
 * Stands in for ffmpeg in tests: `node fake-ffmpeg.ts <log> <ffmpeg args...>`.
 *
 * Writes its pid and the arguments it was given to `<log>`, then streams real
 * 16x16 JPEGs in ffmpeg's own mpjpeg framing until it is killed, as the real
 * one does. Each frame carries its number in a JPEG comment, so a test can
 * tell them apart and a browser still draws them. With `<log>.locked` present
 * it fails the way gdigrab does on a locked desktop instead.
 */

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACA4OEA4QExMTExMTFhUWFxcXFhYWFhcXFxkZGR0dHRkZGRcXGRkcHB0dICEgHh4dHiEhIyMjKiooKDExMjw8SP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAFBhABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AI4BWiH/2Q==",
  "base64",
);

const log = process.argv[2] ?? "";

writeFileSync(log, JSON.stringify({ pid: process.pid, args: process.argv.slice(3) }));

if (existsSync(`${log}.locked`)) {
  process.stderr.write("[gdigrab @ 0000020a] Failed to capture image (error 5)\n");
  process.exit(1);
}

/** A frame with `frame-<n>` in a COM segment straight after the start-of-image marker. */
function frame(n: number): Buffer {
  const note = Buffer.from(`frame-${String(n)}`);
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0, note.length + 2]), note]);
  const jpeg = Buffer.concat([JPEG.subarray(0, 2), comment, JPEG.subarray(2)]);

  return Buffer.concat([
    Buffer.from(
      `--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: ${String(jpeg.length)}\r\n\r\n`,
    ),
    jpeg,
    Buffer.from("\r\n"),
  ]);
}

let sent = 0;
const stalled = existsSync(`${log}.stalled`);

for (; !stalled && sent < 3; sent += 1) {
  process.stdout.write(frame(sent + 1));
}

setInterval(() => {
  if (stalled) return;
  sent += 1;
  process.stdout.write(frame(sent));
}, 200);
