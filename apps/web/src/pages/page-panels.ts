import {
  PagePanelPayloadSchema,
  UuidSchema,
  type ConversationalIdentityId,
  type PagePanelPayload,
  type SurfaceOwner,
} from "@noctis/contracts";
import { z } from "zod";
import { createIdFactory, systemClock } from "@noctis/domain";
import type { CoreTransport } from "../transport/CoreTransport.js";

const CreatedSchema = z.object({ id: UuidSchema }).loose();
const ids = createIdFactory(systemClock);

export async function openPagePanel({
  transport,
  owner,
  identityId,
  payload,
  onOpen,
}: {
  transport: CoreTransport;
  owner?: SurfaceOwner;
  identityId: ConversationalIdentityId;
  payload: PagePanelPayload;
  onOpen?: (id: string) => void;
}): Promise<void> {
  const parsed = PagePanelPayloadSchema.parse(payload);
  if (owner === undefined) {
    const created = await transport.request("POST", "/commands/conversation.create_thread", {
      idempotencyKey: crypto.randomUUID(),
      identityId,
    });
    const result = CreatedSchema.safeParse(created.body);
    if (created.status !== 200 || !result.success)
      throw new Error("Could not create a conversation for this panel. Try again.");
    owner = { threadId: result.data.id };
    // Open immediately so a refused upsert retries on this thread rather than creating another.
    onOpen?.(result.data.id);
  }
  const opened = await transport.request("POST", "/commands/surface.upsert_intent", {
    idempotencyKey: crypto.randomUUID(),
    ...owner,
    kind: "page",
    role: "primary",
    persistence: "restorable",
    priority: 50,
    minSize: "standard",
    payloadVersion: 1,
    sourceIds: [ids.nextId()],
    payload: parsed,
  });
  if (opened.status !== 200 || !CreatedSchema.safeParse(opened.body).success)
    throw new Error("Could not open this panel. Try again.");
}
