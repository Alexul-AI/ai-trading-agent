$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== Apply generated backup gitignore rules ===" -ForegroundColor Cyan

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptPath "..")
$gitignorePath = Join-Path $repoRoot ".gitignore"

$rules = @(
  "",
  "# Generated local patch backups",
  "backend/*.bak-*"
)

if (!(Test-Path $gitignorePath)) {
  New-Item -Path $gitignorePath -ItemType File | Out-Null
}

$content = Get-Content -Path $gitignorePath -Raw -ErrorAction SilentlyContinue
if ($null -eq $content) {
  $content = ""
}

$changed = $false

foreach ($rule in $rules) {
  if ([string]::IsNullOrWhiteSpace($rule)) {
    continue
  }

  if (!$content.Contains($rule)) {
    Add-Content -Path $gitignorePath -Value $rule
    $changed = $true
    Write-Host "OK   Added .gitignore rule: $rule" -ForegroundColor Green
  } else {
    Write-Host "OK   .gitignore already has: $rule" -ForegroundColor Green
  }
}

if ($changed) {
  Write-Host ""
  Write-Host "Updated .gitignore." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "No .gitignore changes needed." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "These backup files are local rollback files only. Do not commit them." -ForegroundColor Cyan
