import { createHash } from "node:crypto";

/**
 * A source id that is the same every time for the same parts, so a Surface
 * keyed on it is found again. Shaped as a v8 UUID, which the schema accepts.
 */
export function stableSourceId(...parts: string[]): string {
  const bytes = createHash("sha256").update(JSON.stringify(parts)).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
