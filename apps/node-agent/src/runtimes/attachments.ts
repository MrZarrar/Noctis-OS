import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AttachmentRef } from "@noctis/contracts";
import { AttachmentFilenameSchema } from "@noctis/contracts";

import { AdapterRefused } from "./Runtime.js";

/**
 * Files in a prompt, made real on this machine for the length of one turn.
 *
 * The node fetches the bytes from the core rather than receiving them in the
 * job frame: a frame is capped at 64 KB (`ws.ts`) and an attachment is capped
 * at 10 MB, so the two would never have fit in one channel. The copy lives in
 * a fresh temp directory and is deleted when the turn ends, which is what keeps
 * an upload a thing the owner did once rather than a file that accumulates on
 * every machine that has ever run a turn.
 */

/** How the runtime is told the files exist. Appended to the prompt, never replacing it. */
const PREAMBLE =
  "Files attached to this message, already saved on this machine — open them with your file tools:";

export interface StagedAttachment {
  ref: AttachmentRef;
  path: string;
}

export interface StagedAttachments {
  /** The temp directory. Handed to the runtime as a readable root so the sandbox allows it. */
  directory: string;
  files: StagedAttachment[];
  discard(): Promise<void>;
}

/**
 * Downloads each attachment, verifies it, and writes it under a new temp
 * directory.
 *
 * The checksum check is not ceremony. These bytes arrive over a second
 * connection from the one the job came in on, and a truncated image that a
 * model then describes confidently is a worse outcome than a turn that refuses
 * to start — so a mismatch is an `AdapterRefused`, which the core records as a
 * failure with a reason, rather than a warning nobody reads.
 *
 * The filename is re-validated here even though the core's schema already did.
 * This is the boundary where a name becomes a path, and a containment rule
 * enforced only at the far end of a network hop is a containment rule that
 * holds until someone adds a second producer.
 */
export async function stageAttachments(
  attachments: readonly AttachmentRef[],
  fetchBytes: (id: string) => Promise<Uint8Array>,
): Promise<StagedAttachments> {
  const directory = await mkdtemp(join(tmpdir(), "noctis-attachments-"));
  const files: StagedAttachment[] = [];

  const discard = async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  };

  try {
    for (const ref of attachments) {
      if (!AttachmentFilenameSchema.safeParse(ref.filename).success) {
        throw new AdapterRefused(`attachment ${ref.id} has a filename this node will not write`);
      }

      const bytes = await fetchBytes(ref.id);
      const actual = createHash("sha256").update(bytes).digest("hex");

      if (actual !== ref.checksum) {
        throw new AdapterRefused(`attachment ${ref.id} did not match its checksum`);
      }

      const path = join(directory, ref.filename);

      await writeFile(path, bytes);
      files.push({ ref, path });
    }
  } catch (error) {
    await discard();
    throw error;
  }

  return { directory, files, discard };
}

/**
 * The prompt, with the attached files named by path.
 *
 * ponytail: paths in the prompt text, not native image blocks. The ceiling is
 * that a vision model reads an image through its own Read tool rather than
 * seeing it inline, which costs a tool call and loses nothing else — and it is
 * one code path that works for a PDF and a CSV as well as a PNG, where the
 * native route would need a second. Upgrade path: `localImage` input items for
 * Codex's `turn/start` and streaming-input image blocks for the Claude SDK,
 * once both shapes are verified against the installed versions rather than
 * guessed at.
 */
export function promptWithAttachments(prompt: string, files: readonly StagedAttachment[]): string {
  if (files.length === 0) {
    return prompt;
  }

  const listed = files.map((file) => `- ${file.path} (${file.ref.mediaType})`).join("\n");

  return `${prompt}\n\n${PREAMBLE}\n${listed}`;
}
