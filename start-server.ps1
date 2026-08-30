# Borrow register system - silent background launcher (no console window)
# Called by start.bat. Redirects node output to log files for troubleshooting.
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $dir

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error 'node not found in PATH. Please install Node.js LTS first.'
  exit 1
}

$outLog = Join-Path $dir 'server.log'
$errLog = Join-Path $dir 'server-err.log'
Start-Process -FilePath $nodeCmd.Source -ArgumentList 'server.js' -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
exit 0
