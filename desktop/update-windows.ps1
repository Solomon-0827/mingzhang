param([int]$ProcessId, [string]$Archive, [string]$Target, [string]$Version)
$ErrorActionPreference = "Stop"
$work = Join-Path $env:TEMP ("mingzhang-update-" + [guid]::NewGuid())
$backup = "$Target.previous"
try {
  Wait-Process -Id $ProcessId -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $Archive -DestinationPath $work -Force
  $candidate = Get-ChildItem -LiteralPath $work -Directory | Select-Object -First 1
  if (-not $candidate) { throw "更新包中没有应用程序" }
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
  Move-Item -LiteralPath $Target -Destination $backup
  try {
    Move-Item -LiteralPath $candidate.FullName -Destination $Target
    Remove-Item -LiteralPath $backup -Recurse -Force
    Remove-Item -LiteralPath $Archive -Force
    Start-Process -FilePath (Join-Path $Target "明账.exe")
  } catch {
    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
    Move-Item -LiteralPath $backup -Destination $Target
    throw
  }
} finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
