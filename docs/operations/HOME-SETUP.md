# Home PC setup: steps waiting for the owner at `zarrarpc`

Everything here was built on the work PC while the home PC was off. Run the steps in order, at the home PC, as the
owner. Each step says how to check it worked. Nothing in this file is run automatically.

## 0. Bring the checkout up to date

```powershell
cd $env:USERPROFILE\Documents\Jarvis\Noctis-OS
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

## 2. The screen mirror

Nodes → Screen → **Mirror** shows this PC's desktop as it is, view only, on the phone or any browser, without
signing anyone out (Remote desktop does sign the console out). The boot node runs in session 0, which has no desktop,
so a small helper runs in your own session from logon. It listens on `127.0.0.1` only, writes its port and a token to
`%LOCALAPPDATA%\Noctis\screen-helper.json`, and runs ffmpeg only while someone is watching. The node finds it through
that file. The work PC needs none of this: its node already runs in your session and starts the helper itself.

The core has to be updated before this PC's node restarts (step 0): the node now offers `screen.view`, and a core
that does not know it refuses the node at hello.

**Install ffmpeg:**

```powershell
winget install --id Gyan.FFmpeg -e
```

Check, in a new PowerShell window: `ffmpeg -version` prints `ffmpeg version 9...`. If it says ffmpeg is not
recognised, the task below finds it in winget's folder instead.

**Build the helper**, if step 0 did not already:

```powershell
cd $env:USERPROFILE\Documents\Jarvis\Noctis-OS
npm run build
Test-Path .\apps\node-agent\dist\screen\helper.js   # True
```

**Start the helper at logon.** As the owner, in PowerShell:

```powershell
$repo = "$env:USERPROFILE\Documents\Jarvis\Noctis-OS"
# The same node.exe the boot node runs, so both are on the pinned version.
$node = (Get-ScheduledTask -TaskName "Noctis node agent").Actions[0].Execute
$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg) {
  $ffmpeg = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter ffmpeg.exe |
    Select-Object -First 1 -ExpandProperty FullName
}
# A task cannot set an environment variable, so the helper reads this one from your profile.
[Environment]::SetEnvironmentVariable("NOCTIS_FFMPEG", $ffmpeg, "User")

$action    = New-ScheduledTaskAction -Execute $node `
  -Argument "`"$repo\apps\node-agent\dist\screen\helper.js`"" -WorkingDirectory $repo
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "Noctis screen helper" -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings
Start-ScheduledTask -TaskName "Noctis screen helper"
```

`-LogonType Interactive` is the point: it runs in the session you signed in to, where the desktop is. Node opens a
console window for it; minimise it. Closing it stops the mirror until the next logon.

**Allow this PC to be watched.** Mirroring is off for every PC until you allow it. In Noctis, open Nodes → Screen →
Mirror, choose `zarrarpc`, and press **Allow mirroring this PC**. That issues a `screen.view` grant through the core's
`node.grant_capability` command, the same as any other grant, and the node is told at once. Sharing folders with the
agents does not include it.

**Check it works:**

1. The helper is up and named its port:

   ```powershell
   $h = Get-Content "$env:LOCALAPPDATA\Noctis\screen-helper.json" | ConvertFrom-Json
   Get-Process -Id $h.pid   # node
   ```

2. It captures. This records three seconds and stops; curl reports a timeout (exit 28), which is expected:

   ```powershell
   curl.exe -s -m 3 -H "x-noctis-screen-token: $($h.token)" `
     "http://127.0.0.1:$($h.port)/mirror?fps=15&width=1280" -o "$env:TEMP\mirror-test.mjpeg"
   (Get-Item "$env:TEMP\mirror-test.mjpeg").Length   # 1.5-2 MB at this size on the work PC; 0 means no capture
   Remove-Item "$env:TEMP\mirror-test.mjpeg"
   Get-Process ffmpeg -ErrorAction SilentlyContinue  # nothing: ffmpeg stops when the request does
   ```

3. From the phone: Nodes → Screen → Mirror → `zarrarpc` → **Watch** shows the desktop. Lock the PC (Win+L) and press
   Watch again: the page says "The PC is locked. Sign in at the PC, or use Remote desktop."

4. Restart, sign in, and check `(Get-ScheduledTaskInfo -TaskName "Noctis screen helper").LastRunTime` matches the
   logon.

If the page says no screen helper is running, step 1 failed: start the task by hand and read the console window. If
it says ffmpeg did not start, `NOCTIS_FFMPEG` points nowhere: re-run the `$ffmpeg` lines above.

To remove it: `Unregister-ScheduledTask -TaskName "Noctis screen helper" -Confirm:$false`.

## 3. Live sessions from VS Code and Codex (the live bridge)

Added 12 October 2026, and already on at the work PC. Your own VS Code and Codex sessions show in Noctis under
Threads → Conversations → **Live sessions**, read only, as they happen. Each PC needs this once, because the hooks live
in your own Claude Code and Codex settings on that PC and report with that PC's node credential.

**Pull, build and restart the node**, so it has the bridge and the other fixes from that day:

```powershell
cd $env:USERPROFILE\Documents\Jarvis\Noctis-OS
git pull --ff-only
npm ci
npm run build
Stop-ScheduledTask -TaskName "Noctis node agent"
Start-ScheduledTask -TaskName "Noctis node agent"
```

**Install the hooks.** As `mmush`, the account the node runs as: the hook reads that account's
`~\.noctis\node.json`.

```powershell
$node = (Get-ScheduledTask -TaskName "Noctis node agent").Actions[0].Execute
& $node apps\node-agent\dist\main.js bridge install
```

It adds four hooks to `~\.claude\settings.json` and `~\.codex\hooks.json` beside yours, and keeps each file as it was
in `*.before-noctis`. Then open Codex (the app or VS Code) and run `/hooks` to trust the new ones: Codex skips a hook
nobody has trusted.

**Check it works:** start a new Claude Code session in VS Code, send one prompt, and it shows under Live sessions as
`zarrarpc` with your prompt and the reply. Do the same in Codex. A session that was already open before the install
does not report until it is started again.

**The other Windows user** on this PC is not covered: their sessions use their own settings and have no node
credential, so the hook says nothing for them. Ask before setting it up for that account.

To remove it: `& $node apps\node-agent\dist\main.js bridge uninstall` removes only the Noctis hooks.
