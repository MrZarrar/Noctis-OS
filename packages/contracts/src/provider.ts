import { z } from "zod";

/**
 * Section 8 provider classes. `metered_api` exists in the vocabulary precisely
 * so the registry can name what it refuses; it is never registrable.
 */
export const ProviderClassSchema = z.enum(["signed_in_runtime", "local_inference", "metered_api"]);

export const ProviderDescriptorSchema = z
  .object({
    id: z.string().trim().min(1),
    providerClass: ProviderClassSchema,
  })
  .strict();

export type ProviderClass = z.infer<typeof ProviderClassSchema>;
export type ProviderDescriptor = z.infer<typeof ProviderDescriptorSchema>;
