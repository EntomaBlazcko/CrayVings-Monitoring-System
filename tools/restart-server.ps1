# Requires: -RunAsAdministrator
# Restart the API server cleanly: kill every instance, wait for the port to
# actually free, start exactly one, and wait for it to listen.
#
# Why this exists: `npm run server` in a second terminal dies with a silent
# EADDRINUSE when an instance is already holding port 3000, which is easy to
# miss. This script makes the duplicate impossible and finishes in about a
# second instead of the several round-trips a manual stop/start needs.
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File tools\restart-server.ps1
#
# Optional:
#   -Port 3000
#   -Quiet          (suppress the per-step output)

param(
  [int]$Port = 3000,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$serverFile = Join-Path $repoRoot "server.cjs"

function Say($msg) {
  if (-not $Quiet) { Write-Host $msg }
}

if (-not (Test-Path -LiteralPath $serverFile)) {
  throw "server.cjs not found at $serverFile"
}

# 1. Stop every running instance of the API server.
$instances = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server\.cjs' })

if ($instances.Count -gt 0) {
  Say "Stopping $($instances.Count) instance(s): $($instances.ProcessId -join ', ')"
  foreach ($p in $instances) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

# 2. Wait for the port to be released, polling rather than sleeping blindly.
$deadline = (Get-Date).AddSeconds(10)
while ((Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) -and
       (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 150
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $Port is still held by another process. Find it with: Get-NetTCPConnection -LocalPort $Port -State Listen"
}
Say "Port $Port is free."

# 3. Start exactly one instance with the repo root as the working directory, so
#    dotenv picks up .env the same way `npm run server` does.
$proc = Start-Process -FilePath "node" `
  -ArgumentList "server.cjs" `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -PassThru

# 4. Wait for it to bind, so the next command does not race the boot.
$deadline = (Get-Date).AddSeconds(20)
do {
  Start-Sleep -Milliseconds 150
  $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
} while (-not $listening -and -not $proc.HasExited -and (Get-Date) -lt $deadline)

if ($proc.HasExited) {
  throw "server.cjs exited immediately with code $($proc.ExitCode). Run it in the foreground to see the error."
}
if (-not $listening) {
  Say "Warning: process is alive (PID $($proc.Id)) but port $Port never opened yet. Check the logs."
} else {
  Say "Server up on port $Port (PID $($proc.Id))."
}
