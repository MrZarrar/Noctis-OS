# Implementation status

## Phase 0 — bootstrap and project truth

Status: accepted (2026-08-23)

| Check                              | State                    | Evidence                                                         |
| ---------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| Independent sibling Git repository | implemented              | repository root; merged to `main` at `bf6660c`                   |
| Donor boundary guard               | red-green implemented    | `npm run test:boundary`                                          |
| Exact JavaScript dependency lock   | implemented              | `package-lock.json`; install audit reports zero vulnerabilities  |
| Source and mockup manifest         | implemented              | `MOCKUP-MANIFEST.md`                                             |
| Donor baseline                     | implemented              | `DONOR-BASELINE.json`; reconfirmed unchanged post-merge          |
| Rust 1.98.0 toolchain              | implemented              | `rustc`, `cargo`, `rustfmt`, and Clippy verified locally         |
| Minimal Tauri 2 desktop scaffold   | implemented              | GitHub Actions `verify` run 32664703461: rust + javascript green |
| Production deployment/activation   | deliberately not started | requires later explicit approval                                 |

## Verification log

Fresh final command evidence is appended at the end of each implementation batch. Historical success
is not treated as current evidence.

### 2026-08-23 bootstrap and first contract slice

| Command                    | Result                                                              |
| -------------------------- | ------------------------------------------------------------------- |
| `npm ci --offline`         | exit 0; 139 packages installed; 147 audited; 0 vulnerabilities      |
| `npm run format:check`     | exit 0; all matched files formatted                                 |
| `npm run lint`             | exit 0; 0 errors                                                    |
| `npm run typecheck`        | exit 0                                                              |
| `npm run test:unit`        | exit 0; 3 files and 30 tests passed                                 |
| `npm run test:boundary`    | exit 0; 6 tests passed, including dirty donor snapshot preservation |
| `npm run test:integration` | exit 0; no integration tests exist yet                              |
| `npm run test:e2e`         | exit 0; no E2E tests exist yet                                      |
| `npm run test:security`    | exit 0; no dedicated security tests exist yet                       |
| `npm run test:performance` | exit 0; no performance tests exist yet                              |
| `npm run build`            | exit 0                                                              |
| `rustc --version`          | exit 0; Rust 1.98.0                                                 |
| `cargo --version`          | exit 0; Cargo 1.98.0                                                |
| `rustfmt --version`        | exit 0; rustfmt component available                                 |
| `cargo clippy --version`   | exit 0; Clippy component available                                  |

Implemented behavior: Objective status/record schemas, fail-closed unknown fields, deterministic
Objective status transitions, Noctis/Jarvis environment namespace isolation, and read-only donor
boundary/snapshot utilities.

The pinned Rust 1.98.0 toolchain is now verified locally. Empty integration, E2E, security, and
performance scripts are scaffolding, not evidence of scenario coverage.

### 2026-08-23 Tauri 2 bootstrap

| Command                             | Result                                                                |
| ----------------------------------- | --------------------------------------------------------------------- |
| `cargo metadata --locked --no-deps` | exit 0; pinned desktop crate and targets resolve                      |
| `npm run tauri -- info`             | Rust, Cargo, MSVC, WebView2, Node, and npm detected                   |
| `npm run test:desktop-bootstrap`    | local compile blocked by enforced Smart App Control, events 3077/3033 |

The compile test first failed because the desktop manifest was absent, proving the red condition. It
then reached dependency compilation after the scaffold and locks were added, where Windows blocked
Cargo's unsigned generated `serde_json` build-script executable with OS error 4551. No App Control
setting was changed. The Windows GitHub Actions Rust job now owns compile, Clippy, test, and unbundled
Tauri-build verification; that evidence remains pending until this commit is pushed.

### 2026-08-23 icon fix, CI evidence, and Phase 0 acceptance

| Command                                               | Result                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `git push` (commit `bf6660c`, `icons/icon.ico` added) | added the Windows exe icon resource `tauri-build` requires unconditionally                                                 |
| GitHub Actions `verify` run `32664703461`             | exit 0; `rust` job green (fmt, clippy, cargo test, unbundled Tauri build); `javascript` job green                          |
| `npm run test:boundary`                               | exit 0; 6 tests passed                                                                                                     |
| `npm run format:check`                                | exit 0                                                                                                                     |
| `npm run lint`                                        | exit 0                                                                                                                     |
| `npm run typecheck`                                   | exit 0                                                                                                                     |
| `npm run test:unit`                                   | exit 0; 3 files and 30 tests passed                                                                                        |
| `npm run build`                                       | exit 0                                                                                                                     |
| Donor repository reconfirmation                       | HEAD `ee7b4527`, branch `dev/personal-pc`, and the single untracked v5 spec file all match `DONOR-BASELINE.json` unchanged |
| `git merge feat/bootstrap-foundation` into `main`     | fast-forward `2ce90b8..bf6660c`; merged-tree checks re-run and green; pushed to `origin/main`                              |

`test:desktop-bootstrap` and `rust:test` were not re-run locally on this machine because no local Rust
toolchain is installed here; the GitHub Actions `rust` job is the authoritative check for those and it
passed.

Phase 0 is accepted. All checks above are implemented and evidenced; production deployment/activation
remains deliberately not started pending later explicit approval.
