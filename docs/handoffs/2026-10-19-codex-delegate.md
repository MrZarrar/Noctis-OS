# Handoff: `noctis_delegate` for the Codex runtime

## The task

Vesper can run on Claude Code or Codex. On the Claude route the agent has a `noctis_delegate` tool: it hands work
to another agent, optionally on another of the owner's PCs, and waits for the answer (see `noctis_delegate` in
`apps/node-agent/src/runtimes/claude.ts`, which calls `proc.current.delegate(args)` → `sink.delegate(...)`, input
schema `RuntimeDelegationSchema.omit({ delegationId: true })` from `@noctis/contracts`).

The Codex route (`apps/node-agent/src/runtimes/codex.ts`) has no such tool. Codex gets Noctis's tools from the stdio
MCP server `apps/node-agent/src/noctis-mcp.ts`, which can only append proposals to a file and cannot wait for a
result. So a Codex Vesper cannot act on another PC, though every message now tells it to: `targetsContext` in
`apps/node-agent/src/runtimes/identity.ts` says "To act on another PC, hand the work to it with noctis_delegate and
its nodeId."

Done means: a Codex turn offers `noctis_delegate` with the same input shape and the same result text as the Claude
route (the JSON of the delegation result without `delegationId`, an error result when it fails), served by the node
through `sink.delegate`, with tests.

## How (suggested, verify it)

Codex's app-server supports client-served **dynamic tools**: the client declares them when starting a thread, Codex
calls them with a server request (`item/tool/call`), and the client answers with the result. `codex.ts` already maps
`dynamicToolCall` thread items for display (`toolItem`, `toolOutput`). Generate the protocol schema with
`codex app-server generate-json-schema --out <dir outside the repo>` and check the exact field names for declaring
dynamic tools on `thread/start` / `thread/resume` and the `item/tool/call` request and response, for the Codex this
node resolves (`resolveCodexCommand`; 0.163). If you can, prove it once live with a throwaway client against the real
`codex app-server` on the owner's ChatGPT login (never an API key: strip `OPENAI_API_KEY` and `CODEX_API_KEY`), a
cheap model such as `gpt-5.6-luna`, and a fake delegate result. Record the raw request and response in your report.

Keep the tool name `noctis_delegate` so the instruction text above works unchanged. A resumed thread must still offer
it.

## Rules

- Follow `AGENTS.md`: write a focused failing test in `apps/node-agent/src/runtimes/codex.test.ts` first, see it
  fail, then make it pass. Use that file's existing fake app-server patterns.
- Edit only `apps/node-agent/src/runtimes/codex.ts` and `codex.test.ts`. Another agent is editing `apps/web/` at
  the same time; do not touch it. Do not change `noctis-mcp.ts` (Hermes uses it too).
- Do not commit, push, stage, or run any git command that changes state.
- Code comments: only a non-obvious why, written like a human engineer. Never cite docs, specs or file paths; never
  sound machine-generated.
- No metered APIs, no deploys, no restarting the running Noctis processes.

## Checks before you finish

From the repo root: `npx vitest run apps/node-agent/src/runtimes/codex.test.ts`, `npx tsc -b --pretty false`,
`npx eslint apps/node-agent/src/runtimes/codex.ts apps/node-agent/src/runtimes/codex.test.ts`, and
`npx prettier --check` on both files. All must pass.

## Report back

Files and functions changed, the protocol evidence (field names, a raw `item/tool/call` request and your response),
the red → green test evidence, check results, and anything you could not verify.
