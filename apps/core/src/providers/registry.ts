import type { ProviderDescriptor } from "@noctis/contracts";
import { ProviderDescriptorSchema } from "@noctis/contracts";

export class ProviderRegistrationError extends Error {}

export interface ProviderRegistry {
  register(descriptor: ProviderDescriptor): void;
  get(id: string): ProviderDescriptor | undefined;
  list(): readonly ProviderDescriptor[];
}

/**
 * Master plan Section 8: metered APIs are "denied and unregistered". Enforced at
 * registration rather than at routing, because a router can only refuse to pick
 * something that is present — and "no error path silently changes cost class"
 * is only true if the expensive class is never in the table to begin with.
 *
 * Phase 2 registers nothing. The registry exists so that the refusal is a
 * mechanism with a test, not a policy nobody implemented yet.
 */
export function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, ProviderDescriptor>();

  return {
    register(descriptor) {
      const parsed = ProviderDescriptorSchema.parse(descriptor);

      if (parsed.providerClass === "metered_api") {
        throw new ProviderRegistrationError(
          `Refusing to register metered provider ${parsed.id}: metered APIs are denied in production architecture`,
        );
      }

      if (providers.has(parsed.id)) {
        throw new ProviderRegistrationError(`Provider ${parsed.id} is already registered`);
      }

      providers.set(parsed.id, parsed);
    },
    get(id) {
      return providers.get(id);
    },
    list() {
      return [...providers.values()];
    },
  };
}
