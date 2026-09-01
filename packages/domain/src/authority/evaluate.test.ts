import type { OperationClass, StandingPermission } from "@noctis/contracts";
import { OperationClassSchema } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import type { AuthorityEvaluationInput } from "./evaluate.js";
import { BASELINE_POLICY_ID, evaluateAuthority } from "./evaluate.js";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const ACTOR = "vesper";
const CAPABILITY = "fs.read";

const ALL_CLASSES: readonly OperationClass[] = OperationClassSchema.options;

/**
 * Operation classes a standing permission may never upgrade. Written out here
 * rather than imported from the module under test, so that deleting an entry in
 * the implementation fails this file instead of agreeing with it.
 */
const NEVER_DELEGABLE: readonly OperationClass[] = [
  "spend",
  "destructive",
  "production_deploy",
  "credential_security",
];

function input(overrides: Partial<AuthorityEvaluationInput> = {}): AuthorityEvaluationInput {
  return {
    operationClass: "read_inspect",
    capability: CAPABILITY,
    actorId: ACTOR,
    objectiveIsActive: false,
    standingPermissions: [],
    now: NOW,
    ...overrides,
  };
}

function permission(overrides: Partial<StandingPermission> = {}): StandingPermission {
  return {
    id: "0199a000-0000-7000-8000-000000000001",
    actorId: ACTOR,
    capability: CAPABILITY,
    operationClass: "external_write",
    constraints: {},
    grantedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("evaluateAuthority", () => {
  it("covers every operation class the contract defines", () => {
    for (const operationClass of ALL_CLASSES) {
      const decision = evaluateAuthority(input({ operationClass }));

      expect(decision.reasonCodes).not.toContain("unknown_operation_class");
      expect(decision.policyId).toBe(BASELINE_POLICY_ID);
    }
  });

  it("denies an operation class outside the policy table", () => {
    const decision = evaluateAuthority(
      input({ operationClass: "not_a_real_class" as OperationClass }),
    );

    expect(decision.outcome).toBe("deny");
    expect(decision.reasonCodes).toEqual(["unknown_operation_class"]);
  });

  it("allows only read_inspect without a scope or a permission", () => {
    for (const operationClass of ALL_CLASSES) {
      const decision = evaluateAuthority(input({ operationClass }));

      if (operationClass === "read_inspect") {
        expect(decision.outcome).toBe("allow");
      } else {
        expect(decision.outcome).not.toBe("allow");
      }
    }
  });

  it("requires typed confirmation for the consequence classes", () => {
    for (const operationClass of NEVER_DELEGABLE) {
      expect(evaluateAuthority(input({ operationClass })).outcome).toBe(
        "require_typed_confirmation",
      );
    }
  });

  it("allows a local reversible edit only inside an active objective", () => {
    const inactive = evaluateAuthority(input({ operationClass: "local_reversible_edit" }));
    const active = evaluateAuthority(
      input({ operationClass: "local_reversible_edit", objectiveIsActive: true }),
    );

    expect(inactive.outcome).toBe("require_confirmation");
    expect(inactive.reasonCodes).toContain("objective_not_active");
    expect(active.outcome).toBe("allow");
    expect(active.reasonCodes).toContain("objective_active_scope");
  });

  it("upgrades a confirmation to allow on a matching standing permission", () => {
    const decision = evaluateAuthority(
      input({
        operationClass: "external_write",
        standingPermissions: [permission()],
      }),
    );

    expect(decision.outcome).toBe("allow");
    expect(decision.reasonCodes).toContain("standing_permission_matched");
    expect(decision.permissionId).toBe(permission().id);
  });

  it("never lets a standing permission cover a consequence class", () => {
    for (const operationClass of NEVER_DELEGABLE) {
      const decision = evaluateAuthority(
        input({
          operationClass,
          standingPermissions: [permission({ operationClass })],
        }),
      );

      expect(decision.outcome).toBe("require_typed_confirmation");
      expect(decision.permissionId).toBeUndefined();
      expect(decision.reasonCodes).toContain("standing_permission_ineligible_operation_class");
    }
  });

  it.each([
    ["revoked", permission({ revokedAt: "2026-08-20T00:00:00.000Z" })],
    ["expired", permission({ expiresAt: "2026-08-31T00:00:00.000Z" })],
    ["expiring exactly now", permission({ expiresAt: "2026-09-01T12:00:00.000Z" })],
    ["for another actor", permission({ actorId: "jester" })],
    ["for another capability", permission({ capability: "fs.write" })],
    ["for another operation class", permission({ operationClass: "publish" })],
  ])("ignores a standing permission that is %s", (_label, unusable) => {
    const decision = evaluateAuthority(
      input({ operationClass: "external_write", standingPermissions: [unusable] }),
    );

    expect(decision.outcome).toBe("require_confirmation");
    expect(decision.permissionId).toBeUndefined();
  });

  it("honours a permission that has not yet expired", () => {
    const decision = evaluateAuthority(
      input({
        operationClass: "external_write",
        standingPermissions: [permission({ expiresAt: "2026-09-01T12:00:00.001Z" })],
      }),
    );

    expect(decision.outcome).toBe("allow");
  });
});
