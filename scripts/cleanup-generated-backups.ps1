param(
  [switch]$Delete
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== Generated backend backup cleanup ===" -ForegroundColor Cyan

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptPath "..")
$backendRoot = Join-Path $repoRoot "backend"

if (!(Test-Path $backendRoot)) {
  throw "Backend folder was not found: $backendRoot"
}

$backupFiles = Get-ChildItem -Path $backendRoot -File -Filter "*.bak-*" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending

if ($backupFiles.Count -eq 0) {
  Write-Host "OK   No generated backend backup files found." -ForegroundColor Green
  exit 0
}

Write-Host "Found generated backend backup files:" -ForegroundColor Yellow
foreach ($file in $backupFiles) {
  Write-Host " - $($file.FullName)"
}

if (!$Delete) {
  Write-Host ""
  Write-Host "Dry-run only. To delete them, run:" -ForegroundColor Cyan
  Write-Host "  .\scripts\cleanup-generated-backups.ps1 -Delete"
  exit 0
}

foreach ($file in $backupFiles) {
  Remove-Item -Path $file.FullName -Force
  Write-Host "OK   Deleted $($file.Name)" -ForegroundColor Green
}

Write-Host ""
Write-Host "OK   Generated backend backup files deleted." -ForegroundColor Green
