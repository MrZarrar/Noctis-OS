# Architecture decisions

## ADR-0001: Independent sibling repository

**Decision:** Build Noctis in `Noctis-OS`, not in the Jarvis repository.

**Reason:** The product is a new system even though selected proven behaviour may be ported. This
keeps implementation, runtime data, releases, and cutover independently reversible.

## ADR-0002: Jarvis is a donor, not a parallel product

**Decision:** Preserve the repository as historical source, while retiring the Jarvis runtime after
Noctis production acceptance and the bounded rollback window.

## ADR-0003: Compatible TypeScript toolchain

**Decision:** Pin TypeScript 6.0.3 rather than 7.0.2 at bootstrap.

**Reason:** `typescript-eslint` 8.67.0 declares support for TypeScript versions below 6.1. Forcing
TypeScript 7 would create an unsupported dependency tree. Revisit after the lint toolchain officially
supports TypeScript 7.

## ADR-0004: Deterministic relational state plus audit events

**Decision:** Use relational operational state and transactionally appended audit events. Do not use
full event sourcing.

## ADR-0005: Consequential behavior is deterministic

**Decision:** Models may propose schema-validated semantic intent. Deterministic code controls
authority, layout, routing, lifecycle, restore, and physical window placement.
