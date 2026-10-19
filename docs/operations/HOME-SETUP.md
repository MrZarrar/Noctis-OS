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

## 4. Panels, the show folder and Anatomy

Added 16 October 2026, and already done at the work PC. Agents now show their work in panels while they work:
interactive pages, Mermaid diagrams, READMEs with their own images, and anything saved in a `noctis-show/` folder in
the working folder. Claude's own artifacts are switched off in Noctis, and edits in Claude's scratchpad no longer
ask. The decisions are in `docs/architecture/2026-10-16-owner-decisions.md`, sections 6 to 11.

The work PC's core is already updated, so the node can restart straight away.

**Pull, build and restart the node.** `npm ci` matters this time: the page gained a package (Mermaid).

```powershell
cd $env:USERPROFILE\Documents\Jarvis\Noctis-OS
git pull --ff-only
npm ci
npm run build
Stop-ScheduledTask -TaskName "Noctis node agent"
Start-ScheduledTask -TaskName "Noctis node agent"
```

Check: `(Get-ScheduledTask -TaskName "Noctis node agent").State` is `Running`, and Nodes in Noctis shows `zarrarpc`
online.

**Keep `noctis-show/` out of every repo.** Agents save figures and screenshots there for Noctis to show, so it must
never be committed. One line in your global git ignore covers every repo on this PC:

```powershell
$ignore = git config --global core.excludesFile
if (-not $ignore) { $ignore = "$env:USERPROFILE\.config\git\ignore" }
$ignore = $ignore -replace '^~', $env:USERPROFILE
New-Item -ItemType Directory -Force (Split-Path $ignore) | Out-Null
if (-not (Test-Path $ignore) -or -not (Select-String -Path $ignore -SimpleMatch 'noctis-show/' -Quiet)) {
  Add-Content -Path $ignore -Value "`n# Files Noctis shows as panels while an agent works; never part of a repo.`nnoctis-show/"
}
```

Check, inside any repo: `git check-ignore -v noctis-show/x.md` prints the ignore file and `noctis-show/`.

**Install the Anatomy skill** for Claude Code and Codex. It explains ideas as interactive isometric figures, which
agents build into `noctis-show/`. It is installed from one reviewed commit with its gallery publishing removed:
that part read Claude's session logs and could force-push to GitHub. Nothing else in it reaches the network.

```powershell
$skill = "$env:USERPROFILE\.claude\skills\anatomy"
git clone --quiet https://github.com/wheresryan22/anatomy.git $skill
git -C $skill checkout --quiet e9488296a44211c42701ff71705b7901470ec78f
Remove-Item -Recurse -Force "$skill\.git", "$skill\.github", "$skill\references\publish.md", `
  "$skill\scripts\publish.mjs", "$skill\scripts\publish.test.mjs", "$skill\scripts\session.mjs", `
  "$skill\scripts\session.test.mjs", "$skill\scripts\fingerprint.mjs"
$lines = Get-Content "$skill\SKILL.md" -Encoding UTF8 |
  Where-Object { $_ -notmatch 'references/publish\.md' } |
  ForEach-Object { $_.Replace(' Also publishes a finished figure to the Anatomy community gallery when asked.', '') }
# WriteAllLines writes UTF-8 without a byte order mark, which the skill's front matter needs.
[IO.File]::WriteAllLines("$skill\SKILL.md", [string[]]$lines)
[IO.File]::WriteAllText("$skill\.source-commit", "e9488296a44211c42701ff71705b7901470ec78f`n")
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agents\skills" | Out-Null
Copy-Item -Recurse $skill "$env:USERPROFILE\.agents\skills\anatomy"
```

Check: `(Select-String -Path "$skill\SKILL.md" -Pattern publish).Count` prints `0`, and
`Test-Path "$env:USERPROFILE\.agents\skills\anatomy\SKILL.md"` prints `True`. A Claude Code session started after
this lists `anatomy` among its skills.

If the other Windows user on this PC should have it too, ask first: it goes in their own profile.

**Check it works end to end:** in Noctis, on a thread running on `zarrarpc`, ask Vesper to "explain how a token
bucket rate limiter works with an interactive figure". A visual panel opens with the figure running in it, and
`git status` in that folder shows nothing new.

## 5. Jarvis switched off for good

On 2026-10-19 the owner retired Jarvis for Noctis. On the work PC its logon task (`Jarvis Production Core`, the
"Agent Dashboard" terminal on port 4820) was removed, and its Claude Code hooks (`hook-handler.js` and
`permission-gate.js`, which ran on every tool call) were taken out of `~/.claude/settings.json`. The donor folder
itself is left alone. Do the same here, as the owner, in PowerShell:

```powershell
# Any task that starts the dashboard, whatever it is called. The Noctis checkout also lives under
# Documents\Jarvis, so match the dashboard folder, not the word Jarvis.
Get-ScheduledTask | Where-Object { ($_.Actions.Execute + ' ' + $_.Actions.Arguments + ' ' +
    $_.Actions.WorkingDirectory) -match 'Jarvis-Sub-Agent-Dashboard' } |
  ForEach-Object { Stop-ScheduledTask -InputObject $_; Unregister-ScheduledTask -InputObject $_ -Confirm:$false }
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'Jarvis-Sub-Agent-Dashboard' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# Its hooks, keeping every other hook (the Noctis bridge hooks included).
$path = "$env:USERPROFILE\.claude\settings.json"
Copy-Item $path "$path.before-jarvis"
$settings = Get-Content $path -Raw | ConvertFrom-Json
foreach ($event in @($settings.hooks.PSObject.Properties.Name)) {
  $kept = @($settings.hooks.$event | Where-Object { -not ($_.hooks.command -match 'Jarvis-Sub-Agent-Dashboard') })
  if ($kept.Count) { $settings.hooks.$event = $kept } else { $settings.hooks.PSObject.Properties.Remove($event) }
}
[IO.File]::WriteAllText($path, ($settings | ConvertTo-Json -Depth 20))
```

Check: `Get-NetTCPConnection -LocalPort 4820 -State Listen -ErrorAction SilentlyContinue` prints nothing, and
`Select-String -Path $path -Pattern Jarvis-Sub-Agent-Dashboard` prints nothing. The home node already starts at logon
(`Noctis node agent`), so nothing else is needed for a reboot.

## 6. Agents that act on this PC: Zen, Windows-MCP, and a node on your desktop

Added 19 October 2026, and already done at the work PC (with Chrome there instead of Zen). Vesper and Jester now
act on the PC rather than explaining what they cannot do: they open things on your screen, work in your own browser
with its logins, and drive desktop apps, stopping to ask before anything that buys, sends, posts or deletes. The
decisions are in `docs/architecture/2026-10-19-owner-decisions.md`, section 1.

The work PC's core is redeployed first: the turn payload now says which PC you are at, and an old node refuses a
payload it does not recognise.

**Pull, build and restart the node** as in step 4 (`git pull --ff-only`, `npm ci`, `npm run build`).

### 6.1 Run the node in your own session

Until now the node started at boot in session 0, which has no desktop, so anything an agent opened there would never
appear on your screen. Windows signs you in within seconds of a restart on this PC, so starting it at logon in your
session costs almost nothing. Re-register it, as the owner, in **elevated** PowerShell:

```powershell
$repo = "$env:USERPROFILE\Documents\Jarvis\Noctis-OS"
$old  = Get-ScheduledTask -TaskName "Noctis node agent"
$node = $old.Actions[0].Execute
Unregister-ScheduledTask -TaskName "Noctis node agent" -Confirm:$false
$action    = New-ScheduledTaskAction -Execute $node `
  -Argument "$repo\apps\node-agent\dist\main.js" -WorkingDirectory $repo
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "Noctis node agent" -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings
Start-ScheduledTask -TaskName "Noctis node agent"
```

Check: `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -match 'node-agent').SessionId`
prints `1` (or whichever session `query user` shows for you), not `0`. Nodes in Noctis shows `zarrarpc` online.

The trade: before anyone signs in, the node is not running. Woken by Wake-on-LAN and left at the lock screen, the PC
comes online in Noctis only after sign-in. The screen helper from step 2 is no longer needed by this node, but
leaving it registered does no harm.

### 6.2 Windows-MCP for Claude, Codex and Jester

Noctis now lends Windows-MCP to every agent itself, as the `desktop` server, without its PowerShell, FileSystem,
Registry and Process tools (each agent's own shell and file tools do those, and Noctis checks those). You do not add
it to `~/.codex/config.toml` or to Hermes: the node finds it and passes it to Claude, Codex and Hermes on every turn.

It looks for `%APPDATA%\Python\Python314\Scripts\windows-mcp.exe`, which is where the 13 October install put it.
Check:

```powershell
Test-Path "$env:APPDATA\Python\Python314\Scripts\windows-mcp.exe"   # True
& "$env:APPDATA\Python\Python314\Scripts\windows-mcp.exe" --help     # lists serve, install, auth
```

If it is somewhere else, point the node at it: `[Environment]::SetEnvironmentVariable("NOCTIS_WINDOWS_MCP",
"<full path to windows-mcp.exe>", "User")`, then restart the node task.

**Take the old Claude entry out.** On 13 October Windows-MCP was also added to your own Claude Code config. In a
Noctis turn that copy would sit beside Noctis's, with its PowerShell tool and an ask on every click. Find its name and
remove it:

```powershell
claude mcp list            # the line whose command ends in windows-mcp.exe
claude mcp remove <that name> -s user
```

Plain Claude Code sessions in VS Code lose it. If you want it there too, ask: it can go back in a project's
`.mcp.json` instead.

**Check Jester asks before a screen step.** Hermes would otherwise run every browser and desktop step without
telling Noctis, so the node writes a small plugin, `noctis-screen`, into each Hermes home and enables it. After the
first Jester and the first Vesper-on-Hermes turn:

```powershell
# The node keeps Jester's Hermes home under NOCTIS_NODE_HOME, or %TEMP%\noctis when that is unset.
$root = if ($env:NOCTIS_NODE_HOME) { $env:NOCTIS_NODE_HOME } else { "$env:TEMP\noctis" }
$env:HERMES_HOME = "$root\hermes-jester"
hermes plugins list   # noctis-screen, enabled
```

Then ask Jester to "open Notepad and type hello" and watch Noctis's activity line: each step shows and no approval
card appears. Ask it to click a button named Send in any app: an approval card must appear. If no card appears, the
plugin did not load. Stop using Jester for screen work and tell Claude what `hermes plugins list` printed.

### 6.3 Zen as the agents' browser

Agents use your real Zen, with your tabs and logins, through Mozilla's `firefox-devtools-mcp`. It documents Firefox,
not Zen, so this step is also the test of whether a Firefox fork works.

**Install the server**, pinned:

```powershell
npm install -g @mozilla/firefox-devtools-mcp@0.10.4
$entry = Join-Path (npm root -g) "@mozilla\firefox-devtools-mcp\dist\index.js"
Test-Path $entry   # True
[Environment]::SetEnvironmentVariable("NOCTIS_FIREFOX_MCP", $entry, "User")
```

**Start Zen with remote control on.** The server attaches to a Zen started with two flags. Edit the Zen shortcut you
use (taskbar and Start), so Target ends with them, for example:

```
"C:\Program Files\Zen Browser\zen.exe" --marionette --remote-debugging-port
```

Close every Zen window and open it from that shortcut. While it runs this way any program on this PC can drive
Zen, and sites can see `navigator.webdriver`, which some shops treat as a bot. Mozilla's own advice is to turn it on
only while automating; if a shop starts asking for captchas, that is why.

Restart the node task so it picks up `NOCTIS_FIREFOX_MCP`.

**Check it works:** in Noctis, on a thread running on `zarrarpc`, ask Vesper "open github.com in a new tab in Zen".
A tab opens in your Zen. If Vesper says the browser would not connect, Zen was not started with both flags; if the
error mentions Marionette, Zen does not support what Mozilla's server needs, and the fallback is to set
`NOCTIS_FIREFOX_MCP` back to nothing and use Chrome or Edge with the Playwright extension, as the work PC does.

### 6.4 Check it all

From the phone, with you away from the home PC but signed in:

1. Vesper on `zarrarpc`: "open my GitHub". It opens in Zen on the PC and Vesper replies with the link.
2. Vesper: "open the vault". The Vault page opens as a panel in Noctis.
3. Jester: "open Notepad and type hello". Notepad opens on the PC with the text, and no approval card appears.
4. Vesper: "find a USB-C cable under £10 on Amazon and add it to my basket". It searches, adds one, and stops; if it
   goes towards checkout, an approval card appears and you press Deny.
5. Codex (pick it under Agent): "take a screenshot of my desktop and tell me what's open". It answers without asking.

## 7. Everything since step 6: usage limits, options panels, page panels, and writing without AI tells

Added 19 October 2026, already live on the work PC. The work PC's core is redeployed first, so the home node can
restart straight away.

What the home node gains:

- Presence shows your Claude and Codex 5-hour and weekly limits, as each provider reports them, with when each
  resets. The home PC's node reads them from its own Claude Code sign-in and `codex app-server`. Until this node is
  updated the core simply asks the work PC instead.
- Options panels: when an agent finds things for you to pick between (products, places, flights), it shows one panel
  with a screenshot, price and link for each and a button to choose one. Screenshots go in `noctis-show/.shots/` in
  the working folder.
- "open the vault" or "health as a panel" opens that Noctis page as a panel instead of launching Obsidian.
- A Codex Vesper can hand work to another PC (`noctis_delegate`).
- An agent hears when a panel it sent will not show, and fixes it in the same turn.
- Vesper and Jester write without the usual AI tells: no em dashes, no "it's not X, it's Y", no eyebrow labels and
  the rest of the list below.

**Pull, build and restart the node:**

```powershell
cd $env:USERPROFILE\Documents\Jarvis\Noctis-OS
git pull --ff-only
npm ci
npm run build
Stop-ScheduledTask  -TaskName "Noctis node agent"
Start-ScheduledTask -TaskName "Noctis node agent"
```

**Add the writing rules to Claude Code and Codex on this PC.** Noctis gives Vesper and Jester these rules itself, but
Claude Code and Codex also read your own instruction files, and so does any session you run outside Noctis. Each PC
keeps its own copy. This appends the same block the work PC has to both files, once:

```powershell
$rules = @'

## Writing style
Applies to everything written for a person: replies, docs, files, commit messages, UI copy. Quoted text and code stay as they are.
- Never use em dashes or spaced en dashes. Use a full stop, comma, colon or brackets.
- No negation framing: "it's not X, it's Y", "not just X but Y", "not X. Not Y. Just Z." Say what the thing is.
- No rhetorical setups such as "The catch?", "The result?" or "Here's the kicker".
- Don't default to threes: three adjectives, three-beat sentences, back-to-back triplets.
- No bold lead-in label on every bullet or paragraph. No "Bottom line:", "TL;DR:" or "Short answer:".
- No preamble, no announcing how many points follow, no restating the question. No closing summary, "Hope this helps" or "Let me know if".
- Never use: delve, robust, leverage, seamless, crucial, pivotal, tapestry, landscape, testament, quietly, genuinely, honestly, truly, fundamentally.
- Write "is" and "has", not "serves as", "stands as" or "boasts".
- No one-line dramatic paragraphs or quotable closing lines, and no invented concept labels presented as established terms.
- Straight quotes and apostrophes. In prose, write "to" instead of arrow characters. No decorative emoji.
- Sentence-case headings, and only when the text is long enough to need them.
- In UI: no small uppercase letter-spaced eyebrow label above headings, no violet glow behind a centred hero, no row of three identical cards, no decorative icon on every card.
'@
foreach ($file in "$env:USERPROFILE\.claude\CLAUDE.md", "$env:USERPROFILE\.codex\AGENTS.md") {
  if (-not (Test-Path $file)) { New-Item -ItemType File -Force -Path $file | Out-Null }
  if (-not (Select-String -Path $file -Pattern '^## Writing style' -Quiet)) {
    # UTF-8 without a byte order mark, as both tools expect.
    [IO.File]::AppendAllText($file, $rules, (New-Object Text.UTF8Encoding $false))
  }
}
```

Check: `Select-String -Path $env:USERPROFILE\.claude\CLAUDE.md, $env:USERPROFILE\.codex\AGENTS.md -Pattern '^## Writing style'`
prints one line for each file.

**Check it works:**

1. Presence shows Claude and Codex, each with a 5H and a WK bar, a percent and a reset time. Claude can say "Claude
   limits how often usage is read; next read in N min" for a few minutes after a restart: Anthropic allows a read
   about every five minutes, and Claude Code reads the same allowance. After that wait the numbers appear.
2. On a thread on `zarrarpc`, ask Vesper "find me three USB-C cables under £10 and let me pick". One options panel
   appears with a screenshot of each. If the screenshots are missing, the browser tool could not save into
   `noctis-show/.shots/`: say so in the thread and it will try another way.
3. Ask Vesper "open the vault". The Vault page opens as a panel in Noctis, not Obsidian.
4. Ask Vesper anything that needs a paragraph back. The reply has no em dashes.
