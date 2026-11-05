param([int]$ProcessId, [string]$Archive, [string]$Target, [string]$Version)
$ErrorActionPreference = "Stop"
$work = Join-Path (Split-Path -Parent $Target) (".mingzhang-update-" + [guid]::NewGuid())
$backup = "$Target.previous-$([guid]::NewGuid())"
try {
  Wait-Process -Id $ProcessId -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $Archive -DestinationPath $work -Force
  $candidate = Get-ChildItem -LiteralPath $work -Directory | Select-Object -First 1
  if (-not $candidate) { throw "Update package has no application directory" }
  if (-not (Test-Path -LiteralPath (Join-Path $Target ".mingzhang-managed"))) { throw "Current application directory is unmanaged" }
  if (-not (Test-Path -LiteralPath (Join-Path $candidate.FullName ".mingzhang-managed"))) { throw "Update package is unmanaged" }
  Move-Item -LiteralPath $Target -Destination $backup
  try {
    Move-Item -LiteralPath $candidate.FullName -Destination $Target
    $executable = Get-ChildItem -LiteralPath $Target -Filter "*.exe" | Where-Object { $_.Name -notmatch "Helper" } | Select-Object -First 1
    if (-not $executable) { throw "Application executable is missing" }
    Start-Process -FilePath $executable.FullName
  } catch {
    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
    Move-Item -LiteralPath $backup -Destination $Target
    throw
  }
  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
} finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
