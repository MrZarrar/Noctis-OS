# Home PC setup: steps waiting for the owner at `zarrarpc`

Everything here was built on the work PC while the home PC was off. Run the steps in order, at the home PC, as the
owner. Each step says how to check it worked. Nothing in this file is run automatically.

## 0. Bring the checkout up to date

```powershell
cd $env:USERPROFILE\Documents\Noctis-OS
git pull --ff-only
npm ci
```

Check: `git log -1 --oneline` matches the latest commit on `origin/main`.

The work PC's core is redeployed first (`scripts/deploy/work-pc.ps1`, from the work PC). A node that advertises
capabilities the core does not know is refused at hello, so restart the home node only after the core is updated.

## 1. The Vault without the code graph

On 2026-10-09 the graphify code graph (8,812 files under `MindVault\projects\jarvis-dashboard\codegraph\`) was moved
out of MindVault on the work PC to `Documents\MindVault-archive\jarvis-dashboard\codegraph`. OneDrive carries the
move to this PC.

Check: `Test-Path "$env:OneDrive\MindVault\projects\jarvis-dashboard\codegraph"` prints `False` once OneDrive has
synced. If it still prints `True` after OneDrive says it is up to date, leave it. Noctis now skips graphify notes
when it indexes, whatever folder they are in.
