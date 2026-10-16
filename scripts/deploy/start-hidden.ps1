<#
  Starts a long-running program hidden, logging to two files, and returns at once.

  Start-Process with -RedirectStandardOutput starts the child with handle
  inheritance on, so the child also inherits whatever pipe this PowerShell's
  own output goes to. Whoever reads that pipe (a terminal tool, CI, a script
  capturing output) then waits until the child exits, which for the core is
  never. Starting cmd through the shell instead inherits no handles, and cmd
  does the redirection to the log files itself.

  Returns the started program's process, not cmd's.
#>
function Start-Hidden {
  param(
    [Parameter(Mandatory)] [string] $File,
    [string[]] $Arguments = @(),
    [Parameter(Mandatory)] [string] $WorkingDirectory,
    [Parameter(Mandatory)] [string] $Out,
    [Parameter(Mandatory)] [string] $Err
  )

  $quoted = (@($File) + $Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $shell = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" `
    -ArgumentList "/d /s /c `"$quoted 1>>`"$Out`" 2>>`"$Err`"`"" `
    -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru

  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    $child = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($shell.Id)" |
      Where-Object { $_.Name -ne 'conhost.exe' } | Select-Object -First 1
    if ($child) {
      return Get-Process -Id $child.ProcessId
    }
    if ($shell.HasExited) {
      throw "$File exited at once; see $Err"
    }
    Start-Sleep -Milliseconds 100
  }

  throw "$File did not start within 10 s"
}
