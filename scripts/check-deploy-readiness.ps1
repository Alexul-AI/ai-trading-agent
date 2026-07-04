param(
  [string]$BaseUrl = "http://localhost:3000",
  [switch]$SkipHttpChecks,
  [switch]$SkipProjectSafetyCheck,
  [switch]$AllowExecutionEnabled,
  [switch]$AllowNonPaperMode
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== Deploy Readiness Audit ===" -ForegroundColor Cyan
Write-Host "Base URL: $BaseUrl"

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptPath "..")
$frontendRoot = Join-Path $repoRoot "frontend"
$backendRoot = Join-Path $repoRoot "backend"
$isCi = ![string]::IsNullOrWhiteSpace($env:CI)

$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

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
  $warnings.Add($Message) | Out-Null
  Write-Host "WARN $Message" -ForegroundColor Yellow
}

function Add-Failure {
  param([string]$Message)
  $failures.Add($Message) | Out-Null
  Write-Host "FAIL $Message" -ForegroundColor Red
}

function Command-Exists {
  param([string]$Command)

  $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Invoke-JsonGet {
  param([string]$Path)

  $uri = "$BaseUrl$Path"

  try {
    return Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 10
  } catch {
    Add-Failure "GET $uri failed: $($_.Exception.Message)"
    return $null
  }
}

Section "Repository basics"

if (!(Test-Path $frontendRoot)) {
  Add-Failure "Missing frontend folder: $frontendRoot"
} else {
  Pass "Found frontend folder"
}

if (!(Test-Path $backendRoot)) {
  Add-Failure "Missing backend folder: $backendRoot"
} else {
  Pass "Found backend folder"
}

$requiredFiles = @(
  "frontend\src\utils\signalReadiness.ts",
  "frontend\src\utils\orderPreview.ts",
  "frontend\src\utils\dateTime.ts",
  "frontend\src\hooks\useNowMs.ts",
  "backend\server.ts",
  "scripts\check-project-safety.ps1",
  "scripts\check-frontend-signal-readiness.ps1",
  "scripts\check-signal-schema.ps1"
)

foreach ($relativePath in $requiredFiles) {
  $path = Join-Path $repoRoot $relativePath

  if (Test-Path $path) {
    Pass "Found $relativePath"
  } else {
    Add-Failure "Missing required file: $relativePath"
  }
}

Section "Backend CORS safety"

$serverTsPath = Join-Path $backendRoot "server.ts"
if (Test-Path $serverTsPath) {
  $serverTs = Get-Content -Path $serverTsPath -Raw

  if ($serverTs -match 'origin\s*:\s*["'']\*["'']') {
    Add-Failure "backend/server.ts still allows wildcard CORS origin '*'. Use FRONTEND_ORIGIN allowlist before deploy."
  } else {
    Pass "No wildcard CORS middleware origin detected"
  }

  if ($serverTs -match 'Access-Control-Allow-Origin["'']\s*,\s*["'']\*["'']') {
    Add-Failure "backend/server.ts still sets wildcard Access-Control-Allow-Origin '*'. SSE/routes must use the allowlist."
  } else {
    Pass "No wildcard Access-Control-Allow-Origin header detected"
  }

  if ($serverTs.Contains("parseCorsOrigins") -and $serverTs.Contains("allowedCorsOrigins")) {
    Pass "CORS allowlist helper detected"
  } else {
    Warn "CORS allowlist helper was not detected. Confirm backend CORS is restricted before deploy."
  }

  if ($serverTs.Contains('app.get("/api/stream"')) {
    if ($serverTs.Contains("resolveAllowedCorsOrigin")) {
      Pass "SSE CORS allowlist helper detected"
    } else {
      Warn "SSE route detected, but resolveAllowedCorsOrigin helper was not found."
    }
  }
}

Section "Backend admin token safety"

if (Test-Path $serverTsPath) {
  $serverTs = Get-Content -Path $serverTsPath -Raw

  if (!$serverTs.Contains("ADMIN_API_TOKEN")) {
    Add-Failure "backend/server.ts does not define ADMIN_API_TOKEN. Protect POST routes before deploy."
  } else {
    Pass "ADMIN_API_TOKEN schema/config detected"
  }

  if (!$serverTs.Contains("function requireAdminToken")) {
    Add-Failure "backend/server.ts does not define requireAdminToken middleware."
  } else {
    Pass "requireAdminToken middleware detected"
  }

  $protectedRoutes = @(
    'app.post("/api/autopilot/run-once", requireAdminToken',
    'app.post("/api/trade", requireAdminToken',
    'app.post("/api/chat", requireAdminToken',
    'app.post("/api/autopilot", requireAdminToken'
  )

  foreach ($route in $protectedRoutes) {
    if (!$serverTs.Contains($route)) {
      Add-Failure "Missing admin token protection for route: $route"
    }
  }

  if (($protectedRoutes | Where-Object { $serverTs.Contains($_) }).Count -eq $protectedRoutes.Count) {
    Pass "All expected POST routes are protected by requireAdminToken"
  }
}

Section "Git and tracked secret files"

$gitAvailable = Command-Exists "git"

if (!$gitAvailable) {
  Warn "git command was not found. Skipping git-based deploy checks."
} else {
  Push-Location $repoRoot
  try {
    $insideGit = git rev-parse --is-inside-work-tree 2>$null

    if ($LASTEXITCODE -ne 0 -or $insideGit.Trim() -ne "true") {
      Warn "Repository is not recognized as a git work tree. Skipping git tracked-file checks."
    } else {
      Pass "Git repository detected"

      $statusLines = git status --porcelain
      if ($statusLines.Count -gt 0) {
        Warn "Working tree has uncommitted changes. Commit or intentionally deploy from this state."
      } else {
        Pass "Working tree is clean"
      }

      $trackedFiles = git ls-files

      $forbiddenTrackedFiles = @(
        ".env",
        ".env.local",
        ".env.production",
        ".env.development",
        "backend/.env",
        "backend/.env.local",
        "backend/.env.production",
        "frontend/.env",
        "frontend/.env.local",
        "frontend/.env.production"
      )

      foreach ($forbiddenFile in $forbiddenTrackedFiles) {
        if ($trackedFiles -contains $forbiddenFile) {
          Add-Failure "Sensitive env file is tracked by git: $forbiddenFile"
        }
      }

      if (($trackedFiles | Where-Object { $_ -match "(^|/)\.env(\.|$)" }).Count -eq 0) {
        Pass "No .env files appear to be tracked"
      }

      $gitignorePath = Join-Path $repoRoot ".gitignore"
      if (Test-Path $gitignorePath) {
        $gitignore = Get-Content -Path $gitignorePath -Raw

        if ($gitignore -match "(?m)^\s*\.env(\*|\b)" -or $gitignore -match "(?m)^\s*\*\*/\.env") {
          Pass ".gitignore contains env-file protection"
        } else {
          Warn ".gitignore does not clearly ignore .env files"
        }

        if ($gitignore.Contains("backend/*.bak-*")) {
          Pass ".gitignore ignores generated backend backup files"
        } else {
          Warn ".gitignore does not ignore generated backend backup files: backend/*.bak-*"
        }
      } else {
        Warn "Missing .gitignore"
      }

      Section "Hardcoded secret scan"

      $secretNamePattern = "(?i)\b(ALPACA_API_KEY|ALPACA_SECRET_KEY|OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|ADMIN_API_TOKEN|JWT_SECRET|DATABASE_URL|PRIVATE_KEY|API_SECRET|ACCESS_TOKEN)\b\s*[:=]\s*['""]?([^'""\s,]+)"
      $skippedFilePattern = "(?i)(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|(\.safe-template$|\.example$|\.sample$|README|NOTES|docs/)"

      foreach ($trackedFile in $trackedFiles) {
        if ($trackedFile -match $skippedFilePattern) {
          continue
        }

        $fullPath = Join-Path $repoRoot $trackedFile

        if (!(Test-Path $fullPath)) {
          continue
        }

        $fileInfo = Get-Item $fullPath
        if ($fileInfo.Length -gt 1MB) {
          continue
        }

        $lines = Get-Content -Path $fullPath -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt $lines.Count; $i++) {
          $line = $lines[$i]

          if ($line -match $secretNamePattern) {
            $keyName = $Matches[1]
            $value = $Matches[2]

            $looksLikeSchemaOrEnvRead =
              $line -match "\bz\." -or
              $line -match "process\.env" -or
              $line -match "\bimport\b" -or
              $line -match "\btype\b" -or
              $line -match "\binterface\b"

            $looksPlaceholder =
              $value -match "(?i)^(change_me|replace_me|your_|example|placeholder|xxx|false|true|null|undefined|0)$" -or
              $value -match "^<.*>$"

            if (!$looksPlaceholder -and !$looksLikeSchemaOrEnvRead) {
              Warn "Possible hardcoded secret assignment found: ${trackedFile}:$($i + 1) key=$keyName. Value not printed."
            }
          }
        }
      }
    }
  } finally {
    Pop-Location
  }
}

Section "Local env safety"

$localEnvFiles = @(
  ".env",
  "backend\.env",
  "frontend\.env",
  ".env.local",
  "backend\.env.local",
  "frontend\.env.local"
)

if ($isCi) {
  Pass "CI detected via env:CI. Skipping local .env file existence warnings."
} else {
  foreach ($relativePath in $localEnvFiles) {
    $path = Join-Path $repoRoot $relativePath

    if (Test-Path $path) {
      Warn "Local env file exists: $relativePath. Keep it out of git and deploy via platform secrets."
    }
  }
}

Section "Project safety check"

if ($SkipProjectSafetyCheck) {
  Warn "Skipping check-project-safety.ps1 by request."
} else {
  $projectSafetyScript = Join-Path $scriptPath "check-project-safety.ps1"

  if (!(Test-Path $projectSafetyScript)) {
    Add-Failure "Missing scripts/check-project-safety.ps1"
  } else {
    try {
      if ($SkipHttpChecks) {
        Warn "Running project safety check with backend HTTP checks skipped because -SkipHttpChecks was provided."
        & $projectSafetyScript -BaseUrl $BaseUrl -SkipBackendHttpChecks
      } else {
        & $projectSafetyScript -BaseUrl $BaseUrl
      }

      if ($LASTEXITCODE -ne 0) {
        Add-Failure "check-project-safety.ps1 failed"
      } else {
        Pass "Project safety check passed"
      }
    } catch {
      Add-Failure "check-project-safety.ps1 failed: $($_.Exception.Message)"
    }
  }
}

if (!$SkipHttpChecks) {
  Section "Deployment runtime gates"

  $status = Invoke-JsonGet "/api/autopilot/status"

  if ($null -ne $status) {
    if ($status.tradeMode -ne "paper") {
      if ($AllowNonPaperMode) {
        Warn "tradeMode is '$($status.tradeMode)', but AllowNonPaperMode was provided."
      } else {
        Add-Failure "tradeMode is '$($status.tradeMode)'. Refusing deploy readiness without -AllowNonPaperMode."
      }
    } else {
      Pass "tradeMode is paper"
    }

    if ($status.executeTrades -eq $true) {
      if ($AllowExecutionEnabled) {
        Warn "executeTrades is true, but AllowExecutionEnabled was provided."
      } else {
        Add-Failure "executeTrades is true. Refusing deploy readiness without -AllowExecutionEnabled."
      }
    } else {
      Pass "executeTrades is false / dry-run"
    }

    if ($status.allowBuy -eq $true -or $status.allowSell -eq $true) {
      Warn "allowBuy/allowSell are enabled. This is safe only while executeTrades=false."
    } else {
      Pass "BUY/SELL execution permissions are disabled"
    }
  }

  $health = Invoke-JsonGet "/api/health?deep=true"

  if ($null -ne $health) {
    if ($health.ok -eq $true) {
      Pass "Deep health check ok"
    } else {
      Add-Failure "Deep health check returned ok != true"
    }
  }
} else {
  Warn "Skipping backend HTTP checks by request."
}

Section "Summary"

if ($warnings.Count -gt 0) {
  Write-Host ""
  Write-Host "Warnings:" -ForegroundColor Yellow
  foreach ($warning in $warnings) {
    Write-Host " - $warning" -ForegroundColor Yellow
  }
}

if ($failures.Count -gt 0) {
  Write-Host ""
  Write-Host "Failures:" -ForegroundColor Red
  foreach ($failure in $failures) {
    Write-Host " - $failure" -ForegroundColor Red
  }

  Write-Host ""
  Write-Host "FAIL: deploy readiness audit failed." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "PASS: deploy readiness audit completed." -ForegroundColor Green
exit 0
