# The tool-routing qualification runbook

Phase 10's gate has four clauses: isolated sessions cannot access personal cookies, visible session
use requires explicit grant, closing and reopening the native tool restores objective context, and
failure degrades safely. Three of those are a person at a desk watching what Noctis actually does.
This is that procedure.

Everything about routing that can be proven without a desk is already in `cargo test` and
`npm run test:unit` — the router's totality, the origin allowlist, the authority refusals. What is
left needs somebody to click a button and see whether the right browser opened.

Record the output of each step. The point is not that it passes; it is that what passed is written
down beside the configuration it passed on.

## What this phase built, and what it did not

Read this first, because two of the four routes are deliberately absent and a runbook that did not
say so would look like it was failing.

| Route              | Capability                  | Built this phase                |
| ------------------ | --------------------------- | ------------------------------- |
| `official_cli`     | `tool.run_command`          | yes — resolve, launch, or run   |
| `isolated_browser` | `browser.automate_isolated` | **no** — routed to, reports why |
| `visible_handoff`  | `browser.open_visible`      | yes — opens your own browser    |
| `manual`           | `tool.inspect`              | yes — the terminal fallback     |

Existing-profile _control_ (`browser.control_profile`) is a declared capability with no executor and
no route. It exists so that the separation Section 12.3 requires is expressed in the authority model
rather than added later; nothing can currently take it.

**MeshCentral-style screen access is not built and is not behind a flag.** Phase 10 says it needs a
separate future flag and a security review, and it is not v1-critical. There is nothing to qualify.

## The configuration

| Thing              | Expected                                                         |
| ------------------ | ---------------------------------------------------------------- |
| Visual Studio Code | installed for the current user, so `Code.exe` resolves on `PATH` |
| Default browser    | set, and signed in to nothing in particular                      |
| `tools.json`       | absent, so the built-in descriptors are what is under test       |
| An Objective       | one, activated, so the reversible routes do not prompt           |

The built-in descriptors are `vscode` (a detached `official_cli` route), `suno` and `vinted` (each a
`visible_handoff` route). They are there to prove the routes, not to enumerate the product — Phase 11
adds rows, and if it needs code, this phase failed.

## Step 1 — the survey, read-only

Start the core and the shell, activate an Objective, and look at the **External tool** Surface.

Expect one row per built-in tool, each naming the route Noctis would take:

| Tool               | Expected route    | Expected line                                  |
| ------------------ | ----------------- | ---------------------------------------------- |
| Visual Studio Code | `official_cli`    | "Noctis will go through its own command line"  |
| Suno               | `visible_handoff` | "Noctis will go in your own signed-in browser" |
| Vinted             | `visible_handoff` | "Noctis will go in your own signed-in browser" |

Two things to check rather than skim:

- **The two browser routes must not read alike.** "In your own signed-in browser" and "in an
  isolated browser holding none of your sign-ins" are different things to agree to, and a person who
  cannot tell them apart on the Surface cannot consent to either.
- **No row shows an executable path or a URL.** The survey deliberately carries neither. If one
  appears, the page has been handed something it could disagree with.

With Code uninstalled, the editor's row should read `official_cli` degraded and fall to `manual`,
saying "Visual Studio Code is not installed here" — named by the tool, never by the binary.

## Step 2 — launch, and the correlation Phase 9 left empty

This is the row that closes Phase 9's carried-forward task item. Phase 9 discovered windows and
never opened one; the correlation map existed and nothing wrote to it.

1. Close every VS Code window.
2. On the editor's row, press **Go there**.
3. Expect the state to become **started**, naming a process id.
4. Press **Look again** on the native-application Surface, then arrange the editor.

| Row                                                                 | Result |
| ------------------------------------------------------------------- | ------ |
| Editor launches, and the Surface names a process id                 |        |
| No prompt appeared, because an Objective is active                  |        |
| The arranged editor is the one Noctis started                       |        |
| Opening a _second_ editor by hand, then arranging, prefers Noctis's |        |

The last row is the point of correlation. With two editors open and one of them started by Noctis,
placement should choose that one rather than reporting `ambiguous` — `select_window` prefers a
correlated window, and until this phase nothing could ever set the id it compares.

## Step 3 — the visible handoff, and the preparation boundary

1. On Vinted's row, press **Go there**.
2. Expect your **own** browser to open, signed in, at the new-listing form.
3. Expect the Surface to say: "Noctis stopped here. Anything that sends, publishes, or spends is
   yours to do."

| Row                                                     | Result |
| ------------------------------------------------------- | ------ |
| Your own default browser opened, not a fresh profile    |        |
| The URL is the one the descriptor declared              |        |
| The Surface states the boundary rather than implying it |        |
| Nothing was submitted, listed, or sent                  |        |

**The gate clause this covers**: "visible session use requires explicit grant". Under an active
Objective this is `local_reversible_edit` and proceeds without a prompt, which is the grant scope
Section 9.1 defines — not the absence of one. To see the prompt, pause the Objective and press **Go
there** again: it should ask, and the consequence summary should name Vinted and say "in your own
signed-in browser".

| Row                                                            | Result |
| -------------------------------------------------------------- | ------ |
| With no active Objective, the handoff asks first               |        |
| The approval names the tool and says whose browser it will use |        |
| Declining it opens nothing                                     |        |

## Step 4 — degradation, which is most of the phase

The isolated route is not built, and the honest behaviour is to say so and route past it rather than
fail at execution.

| Row                                                                  | Result |
| -------------------------------------------------------------------- | ------ |
| A tool declaring only `isolated_browser` falls back to `manual`      |        |
| The Surface lists what it passed over and why                        |        |
| A tool with no routes at all still shows instructions                |        |
| **Look again** re-surveys and can change the answer after an install |        |

The third row is the one that matters most, and it is the cheapest to test: add a tool to
`%APPDATA%\com.noctis.os\tools.json` with no routes at all —

```json
[
  {
    "id": "notion",
    "displayName": "Notion",
    "instructions": "Open Notion and paste the draft into today's page.",
    "routes": []
  }
]
```

— then press **Look again**. It should appear, routed to `manual`, showing that instruction. Adding
a tool is a row in a file, not a code change; this row is the test of that claim.

## Step 5 — what a caller may not do

These are the refusals, and every one of them is already covered by a Rust test. Run them here only
if a change has touched `tool_authority.rs` or `tool_registry.rs`, because the interesting version of
each is the unit test and not the click.

| Refusal                                                 | Where it is proven                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| A route the tool does not declare                       | `refuses_a_route_the_tool_does_not_declare`                       |
| A verb the tool does not declare                        | `refuses_a_verb_the_tool_does_not_declare`                        |
| An approval issued for a different tool                 | `refuses_an_approval_granted_for_a_different_tool`                |
| An approval for opening a tab used to drive the profile | `refuses_an_approval_for_a_different_capability_on_the_same_tool` |
| A URL outside the descriptor's origins                  | `does_not_let_a_lookalike_host_inherit_the_grant`                 |
| An argument that could extend the command line          | `refuses_an_argument_that_could_extend_the_command_line`          |
| A verb understating its own consequence                 | `raises_the_class_to_the_verb_and_never_below_the_floor`          |

## Carried over from the Windows runbook

Four rows of `docs/operations/windows-qualification.md` Step 3 are recorded unverified rather than
passing, because the override mechanism was only ever observed honouring a preference that came from
a defect. They are three clicks, and the shell is already running for Step 2 above, so they belong in
the same session:

| Row                                 | Result |
| ----------------------------------- | ------ |
| Drag by hand, then arrange again    |        |
| The same after a shell restart      |        |
| **Use the intended region instead** |        |
| Unplug the second display           |        |

Step 4 of that runbook — a scaled display — does not apply. The intended configuration is 100% on
both monitors, chosen deliberately, and it is not a surface this desk has.
