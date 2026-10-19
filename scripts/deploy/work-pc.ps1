<#
.SYNOPSIS
  Deploys the Noctis core on the work PC: pull, install, build, restart, check.

.DESCRIPTION
  One command for docs/operations/work-pc-core.md's manual steps, in the order
  they have to happen:

    1. refuse unless this is the work PC, on main, with a clean working tree;
    2. git pull --ff-only (never a merge, never a reset);
    3. stop the running core and this PC's node agent (the node processes running
       apps\core\dist and apps
ode-agent\dist), because npm ci cannot replace
       node_modules under a live process;
    4. npm ci, npm run build, npm run build:web, with VITE_CORE_TOKEN removed
       from this process so it cannot be inlined into the page;
    5. start the core again, hidden, logging to %LOCALAPPDATA%\Noctis, with
       every NOCTIS_* variable re-read from the registry, because a terminal
       opened before a variable was set does not have it;
    6. wait for /health;
    7. start the node agent again, the same way, and check it stays up.

  Both are started detached from this script's output (start-hidden.ps1), so
  a tool or terminal that runs the deploy gets its prompt back.

  It registers nothing itself: no service, no scheduled task. With -StartOnly
  it skips the pull, the install and the build and starts what is already
  built, even with work in progress in the tree; the "Noctis" logon task runs
  it that way so a reboot brings Noctis back.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy\work-pc.ps1
#>
[CmdletBinding()]
param(
  [string] $ExpectedHost = 'mushafzarrar',
  [string] $RepoRoot = '',
  [switch] $DryRun,
  [switch] $StartOnly
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'start-hidden.ps1')

# Here, not as the parameter default: Windows PowerShell 5.1 leaves $PSScriptRoot
# empty while it binds parameters.
if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

function Write-Step([string] $Label) {
  Write-Host "==> $Label"
}

function Stop-Deploy([string] $Message) {
  [Console]::Error.WriteLine("deploy refused: $Message")
  exit 1
}

function Invoke-Checked([string] $Label, [string] $File, [string[]] $Arguments) {
  Write-Step $Label

  if ($DryRun) {
    return
  }

  & $File @Arguments

  if ($LASTEXITCODE -ne 0) {
    Stop-Deploy "$Label exited with $LASTEXITCODE"
  }
}

# 1. Where, and what.
if ($env:COMPUTERNAME -ne $ExpectedHost) {
  Stop-Deploy "this is $env:COMPUTERNAME, not $ExpectedHost. The core runs on the work PC only (ADR-0027); check hostname."
}

Set-Location $RepoRoot

if (-not $StartOnly) {
  $dirty = git status --porcelain
  if ($LASTEXITCODE -ne 0) {
    Stop-Deploy "$RepoRoot is not a git repository"
  }
  if ($dirty) {
    Stop-Deploy "$RepoRoot has uncommitted changes. Commit or stash them first; a deploy builds what is committed, nothing else."
  }

  $branch = git rev-parse --abbrev-ref HEAD
  if ($branch -ne 'main') {
    Stop-Deploy "$RepoRoot is on '$branch', not main"
  }
}

$nodeVersion = node --version
if ($nodeVersion -notlike 'v22.*') {
  Stop-Deploy "Node is $nodeVersion; Noctis needs 22.x"
}
if ($nodeVersion -ne 'v22.23.2') {
  Write-Warning "Node is $nodeVersion; the pinned version is v22.23.2."
}

# The environment the core will actually start with: every NOCTIS_* variable
# as the registry holds it now, user scope over machine scope.
foreach ($scope in 'Machine', 'User') {
  $variables = [Environment]::GetEnvironmentVariables($scope)
  foreach ($name in $variables.Keys) {
    if ($name -like 'NOCTIS_*') {
      Set-Item -Path "Env:$name" -Value $variables[$name]
    }
  }
}
Remove-Item Env:VITE_CORE_TOKEN -ErrorAction SilentlyContinue

$port = if ($env:NOCTIS_CORE_PORT) { $env:NOCTIS_CORE_PORT } else { '7717' }
$logDirectory = Join-Path $env:LOCALAPPDATA 'Noctis'

# 2. Pull.
if (-not $StartOnly) {
  Invoke-Checked 'git pull --ff-only' 'git' @('pull', '--ff-only')
}

# 3. Stop.
Write-Step 'stop the running core and node'
$running = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*apps?core?dist?main.js*' -or $_.CommandLine -like '*apps?node-agent?dist?*' })
foreach ($process in $running) {
  Write-Host "    stopping PID $($process.ProcessId)"
  if (-not $DryRun) {
    Stop-Process -Id $process.ProcessId -Force
  }
}

# 4. Install and build.
if (-not $StartOnly) {
  Invoke-Checked 'npm ci' 'npm' @('ci')
  Invoke-Checked 'npm run build' 'npm' @('run', 'build')
  Invoke-Checked 'npm run build:web' 'npm' @('run', 'build:web')
}

# 5. Start.
Write-Step 'start the core'
$out = Join-Path $logDirectory 'core.out.log'
$err = Join-Path $logDirectory 'core.err.log'
Write-Host "    logs: $out, $err"
Write-Host "    remote desktop: $(if ($env:NOCTIS_REMOTE_DESKTOPS) { 'configured' } else { 'off (NOCTIS_REMOTE_DESKTOPS unset)' })"

# 6. Check.
Write-Step "wait for http://127.0.0.1:$port/health"

if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  $core = Start-Hidden -File (Get-Command node).Source -Arguments @('apps\core\dist\main.js') `
    -WorkingDirectory $RepoRoot -Out $out -Err $err

  $healthy = $false
  $deadline = (Get-Date).AddSeconds(30)
  while (-not $healthy -and (Get-Date) -lt $deadline) {
    if ($core.HasExited) {
      Get-Content $err -Tail 20 -ErrorAction SilentlyContinue
      Stop-Deploy "the core exited; the last lines of $err are above"
    }

    try {
      $healthy = (Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2).status -eq 'ok'
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  if (-not $healthy) {
    Stop-Deploy "the core did not answer /health within 30 s; see $out and $err"
  }

  Write-Host "core is up: PID $($core.Id), port $port. Stop it with: Stop-Process -Id $($core.Id)"
}

# 7. The node agent. The core is already up, so a node that will not start is
# a warning to read, not a failed deploy.
Write-Step 'start the node'
$nodeOut = Join-Path $logDirectory 'node.out.log'
$nodeErr = Join-Path $logDirectory 'node.err.log'
Write-Host "    logs: $nodeOut, $nodeErr"

if ($DryRun) {
  Write-Host 'dry run: nothing was changed'
  exit 0
}

try {
  $node = Start-Hidden -File (Get-Command node).Source -Arguments @('apps\node-agent\dist\main.js') `
    -WorkingDirectory $RepoRoot -Out $nodeOut -Err $nodeErr
  Start-Sleep -Seconds 5
  if ($node.HasExited) {
    Get-Content $nodeErr -Tail 20 -ErrorAction SilentlyContinue
    Write-Warning "the node agent exited; the last lines of $nodeErr are above"
  } else {
    Write-Host "node is up: PID $($node.Id). Stop it with: Stop-Process -Id $($node.Id)"
  }
} catch {
  Write-Warning "the node agent did not start: $($_.Exception.Message)"
}

exit 0
