import type {
  RuntimeAnswer,
  RuntimeAsk,
  RuntimeItem,
  RuntimeProbe,
  RuntimeProviderId,
  RuntimeTurnEvidence,
  RuntimeTurnPayload,
} from "@noctis/contracts";

/** The node refused the job itself. Reported to the core as a failure, not a crash. */
export class AdapterRefused extends Error {}

/** Grant roots made real: every path is a `realpath`, so junctions cannot widen a grant. */
export interface ResolvedRoots {
  cwd: string;
  writable: string[];
  readable: string[];
  localOnly: boolean;
}

/** What a runtime says mid-turn. `ask` blocks until the core answers; the runtime never decides. */
export interface RuntimeSink {
  item(item: RuntimeItem): void;
  delta(itemId: string, text: string): void;
  ask(ask: Omit<RuntimeAsk, "askId">): Promise<RuntimeAnswer>;
}

export interface RuntimeTurnInput {
  payload: RuntimeTurnPayload;
  roots: ResolvedRoots;
  /** Already stripped of billing keys. A runtime spawns children with this and nothing else. */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

export interface Runtime {
  providerId: RuntimeProviderId;
  probe(): Promise<RuntimeProbe>;
  turn(input: RuntimeTurnInput, sink: RuntimeSink): Promise<RuntimeTurnEvidence>;
}
