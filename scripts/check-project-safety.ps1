param(
  [string]$BaseUrl = "http://localhost:3000",
  [switch]$SkipFrontendBuild,
  [switch]$SkipBackendBuild,
  [switch]$SkipBackendHttpChecks
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== Trading Dashboard Project Safety Check ===" -ForegroundColor Cyan
Write-Host "Base URL: $BaseUrl"

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptPath "..")
$frontendRoot = Join-Path $repoRoot "frontend"
$backendRoot = Join-Path $repoRoot "backend"

function Section {
  param([string]$Title)
  Write-Host ""
  Write-Host "=== $Title ===" -ForegroundColor Cyan
}

function Pass {
  param([string]$Message)
  Write-Host "OK   $Message" -ForegroundColor Green
}

function Warn {
  param([string]$Message)
  Write-Host "WARN $Message" -ForegroundColor Yellow
}

function Fail {
  param([string]$Message)
  Write-Host "FAIL $Message" -ForegroundColor Red
  throw $Message
}

function Require-File {
  param([string]$Path)

  if (!(Test-Path $Path)) {
    Fail "Missing file: $Path"
  }

  Pass "Found $Path"
}

function Invoke-JsonGet {
  param([string]$Path)

  $uri = "$BaseUrl$Path"
  try {
    return Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 10
  } catch {
    Fail "GET $uri failed: $($_.Exception.Message)"
  }
}

Section "Required files"

Require-File (Join-Path $frontendRoot "src\utils\signalReadiness.ts")
Require-File (Join-Path $frontendRoot "src\utils\orderPreview.ts")
Require-File (Join-Path $frontendRoot "src\utils\dateTime.ts")
Require-File (Join-Path $frontendRoot "src\hooks\useNowMs.ts")
Require-File (Join-Path $backendRoot "server.ts")
Require-File (Join-Path $backendRoot "envHealth.ts")
Require-File (Join-Path $backendRoot "tsconfig.json")
Require-File (Join-Path $scriptPath "check-frontend-signal-readiness.ps1")
Require-File (Join-Path $scriptPath "check-signal-schema.ps1")

Section "Frontend safety audit"

& (Join-Path $scriptPath "check-frontend-signal-readiness.ps1")
if ($LASTEXITCODE -ne 0) {
  Fail "Frontend safety audit failed."
}
Pass "Frontend safety audit passed."

if (!$SkipFrontendBuild) {
  Section "Frontend production build"

  Push-Location $frontendRoot
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) {
      Fail "Frontend build failed."
    }
  } finally {
    Pop-Location
  }

  Pass "Frontend build passed."
} else {
  Warn "Skipping frontend build by request."
}

if (!$SkipBackendBuild) {
  Section "Backend TypeScript build"

  Push-Location $backendRoot
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) {
      Fail "Backend build failed."
    }
  } finally {
    Pop-Location
  }

  Pass "Backend build passed."
} else {
  Warn "Skipping backend build by request."
}

if ($SkipBackendHttpChecks) {
  Warn "Skipping backend HTTP checks by request."
  Write-Host ""
  Write-Host "PASS: project safety check completed with backend HTTP checks skipped." -ForegroundColor Green
  exit 0
}

Section "Backend health"

$health = Invoke-JsonGet "/api/health"
if ($health.ok -ne $true) {
  Fail "/api/health returned ok != true"
}
Pass "/api/health ok"

$deepHealth = Invoke-JsonGet "/api/health?deep=true"
if ($deepHealth.ok -ne $true) {
  Fail "/api/health?deep=true returned ok != true"
}
Pass "/api/health?deep=true ok"

Section "Dashboard endpoint"

$dashboard = Invoke-JsonGet "/api/dashboard"
if ($null -eq $dashboard) {
  Fail "/api/dashboard returned empty response"
}
Pass "/api/dashboard returned data"

if ($dashboard.health -and $dashboard.health.warnings -and $dashboard.health.warnings.Count -gt 0) {
  Warn "/api/dashboard reports $($dashboard.health.warnings.Count) warning(s)."
} else {
  Pass "/api/dashboard health has no warnings"
}

Section "Autopilot status"

$status = Invoke-JsonGet "/api/autopilot/status"

$requiredStatusFields = @(
  "tradeMode",
  "executeTrades",
  "allowBuy",
  "allowSell",
  "minConfidence",
  "maxSellFraction",
  "strategyVersion",
  "strategyConfigHash",
  "strategyConfig"
)

foreach ($field in $requiredStatusFields) {
  if (!($status.PSObject.Properties.Name -contains $field)) {
    Fail "/api/autopilot/status missing field: $field"
  }
}

Pass "/api/autopilot/status has required safety/config fields"

if ($status.tradeMode -ne "paper") {
  Warn "tradeMode is '$($status.tradeMode)', expected 'paper' for safe testing."
} else {
  Pass "tradeMode is paper"
}

if ($status.executeTrades -eq $true) {
  Warn "executeTrades is true. Paper orders may be submitted when policy permits."
} else {
  Pass "executeTrades is false / dry-run"
}

Section "Strict signal schema smoke test"

& (Join-Path $scriptPath "check-signal-schema.ps1") -BaseUrl $BaseUrl
if ($LASTEXITCODE -ne 0) {
  Fail "Strict signal schema smoke test failed."
}
Pass "Strict signal schema smoke test passed."

Write-Host ""
Write-Host "PASS: project safety check completed." -ForegroundColor Green
