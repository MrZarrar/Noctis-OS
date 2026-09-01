import type { AuthorityOutcome, OperationClass, StandingPermission } from "@noctis/contracts";

export const BASELINE_POLICY_ID = "baseline.v1";

/**
 * Master plan Section 9.1, "Default policy". Pure and total over the enum.
 *
 * `local_reversible_edit` is listed as "allow or require confirmation by scope";
 * the scope test lives in `evaluateAuthority`, and this table holds the stricter
 * of the two so a scope check that never runs cannot silently widen authority.
 */
const DEFAULT_OUTCOME: Readonly<Record<OperationClass, AuthorityOutcome>> = {
  read_inspect: "allow",
  local_reversible_edit: "require_confirmation",
  external_write: "require_confirmation",
  message_send: "require_confirmation",
  publish: "require_confirmation",
  spend: "require_typed_confirmation",
  destructive: "require_typed_confirmation",
  production_deploy: "require_typed_confirmation",
  credential_security: "require_typed_confirmation",
};

/**
 * "Standing permissions ... cannot cover spend, destructive operations,
 * production activation, credential/security changes, or widening their own
 * scope." Kept as its own set rather than inferred from the outcome table, so
 * that relaxing a default outcome cannot accidentally make one of these
 * delegable.
 */
const PERMISSION_INELIGIBLE: ReadonlySet<OperationClass> = new Set<OperationClass>([
  "spend",
  "destructive",
  "production_deploy",
  "credential_security",
]);

export interface AuthorityEvaluationInput {
  operationClass: OperationClass;
  capability: string;
  actorId: string;
  /** True only when the request names an Objective that is currently `active`. */
  objectiveIsActive: boolean;
  standingPermissions: readonly StandingPermission[];
  /** Epoch milliseconds from the injected clock. */
  now: number;
}

export interface AuthorityEvaluation {
  outcome: AuthorityOutcome;
  policyId: string;
  reasonCodes: string[];
  permissionId?: string;
}

function isUsable(permission: StandingPermission, input: AuthorityEvaluationInput): boolean {
  if (permission.revokedAt !== undefined) {
    return false;
  }
  if (permission.expiresAt !== undefined && Date.parse(permission.expiresAt) <= input.now) {
    return false;
  }

  return (
    permission.actorId === input.actorId &&
    permission.capability === input.capability &&
    permission.operationClass === input.operationClass
  );
}

/**
 * The single authority decision function. Pure, deterministic, and fail-closed:
 * an operation class outside the table denies rather than falling through.
 */
export function evaluateAuthority(input: AuthorityEvaluationInput): AuthorityEvaluation {
  const base = DEFAULT_OUTCOME[input.operationClass] as AuthorityOutcome | undefined;

  if (base === undefined) {
    return {
      outcome: "deny",
      policyId: BASELINE_POLICY_ID,
      reasonCodes: ["unknown_operation_class"],
    };
  }

  const reasonCodes = ["operation_class_default"];

  if (input.operationClass === "local_reversible_edit") {
    if (input.objectiveIsActive) {
      return {
        outcome: "allow",
        policyId: BASELINE_POLICY_ID,
        reasonCodes: ["objective_active_scope"],
      };
    }
    reasonCodes.push("objective_not_active");
  }

  const permission = input.standingPermissions.find((candidate) => isUsable(candidate, input));

  if (permission === undefined) {
    return { outcome: base, policyId: BASELINE_POLICY_ID, reasonCodes };
  }

  if (PERMISSION_INELIGIBLE.has(input.operationClass)) {
    // Recorded rather than ignored: an operator who granted a permission that
    // cannot apply should be able to see that in the audit trail.
    reasonCodes.push("standing_permission_ineligible_operation_class");
    return { outcome: base, policyId: BASELINE_POLICY_ID, reasonCodes };
  }

  if (base !== "require_confirmation") {
    return { outcome: base, policyId: BASELINE_POLICY_ID, reasonCodes };
  }

  reasonCodes.push("standing_permission_matched");

  return {
    outcome: "allow",
    policyId: BASELINE_POLICY_ID,
    reasonCodes,
    permissionId: permission.id,
  };
}
