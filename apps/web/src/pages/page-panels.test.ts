import { expect, it, vi } from "vitest";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { openPagePanel } from "./page-panels.js";

it("creates panel ownership without a model prompt and opens the returned thread", async () => {
  const id = "0199a000-0000-7000-8000-000000000001";
  const request = vi
    .fn()
    .mockResolvedValueOnce({ status: 200, body: { id } })
    .mockResolvedValueOnce({ status: 200, body: { id } });
  const onOpen = vi.fn();
  await openPagePanel({
    transport: { request } as unknown as CoreTransport,
    identityId: "jester",
    onOpen,
    payload: { page: "Files" },
  });
  expect(request.mock.calls[0]).toEqual([
    "POST",
    "/commands/conversation.create_thread",
    expect.objectContaining({ identityId: "jester" }),
  ]);
  expect(request.mock.calls[1]).toEqual([
    "POST",
    "/commands/surface.upsert_intent",
    expect.objectContaining({ threadId: id, kind: "page", payload: { page: "Files" } }),
  ]);
  expect(onOpen).toHaveBeenCalledWith(id);
});
it("reuses a current thread or Presence and reports bounded refusals", async () => {
  const id = "0199a000-0000-7000-8000-000000000001";
  const request = vi.fn().mockResolvedValue({ status: 200, body: { id } });
  const transport = { request } as unknown as CoreTransport;
  for (const owner of [{ threadId: id }, { presence: true as const }]) {
    await openPagePanel({ transport, owner, identityId: "vesper", payload: { page: "Settings" } });
    expect(request.mock.calls.at(-1)?.[2]).toMatchObject(owner);
  }
  expect(request).toHaveBeenCalledTimes(2);
  request.mockResolvedValue({ status: 503, body: {} });
  await expect(
    openPagePanel({ transport, identityId: "vesper", payload: { page: "Settings" } }),
  ).rejects.toThrow("Could not create");
  await expect(
    openPagePanel({
      transport,
      owner: { threadId: id },
      identityId: "vesper",
      payload: { page: "Settings" },
    }),
  ).rejects.toThrow("Could not open");
});
