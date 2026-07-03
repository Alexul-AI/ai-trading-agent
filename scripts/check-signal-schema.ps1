param(
  [string]$BaseUrl = "http://localhost:3000"
)

$ErrorActionPreference = "Stop"

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host "=== $Title ===" -ForegroundColor Cyan
}

function Get-PropertyNames {
  param([object]$Object)

  if ($null -eq $Object) {
    return @()
  }

  return @($Object.PSObject.Properties.Name)
}

function Assert-HasProperty {
  param(
    [object]$Object,
    [string]$Property,
    [string]$Context
  )

  $names = Get-PropertyNames $Object

  if ($names -notcontains $Property) {
    throw "FAIL [$Context]: missing required property '$Property'"
  }

  Write-Host "OK   [$Context]: has '$Property'" -ForegroundColor Green
}

function Assert-DoesNotHaveProperty {
  param(
    [object]$Object,
    [string]$Property,
    [string]$Context
  )

  $names = Get-PropertyNames $Object

  if ($names -contains $Property) {
    throw "FAIL [$Context]: forbidden legacy property '$Property' is present"
  }

  Write-Host "OK   [$Context]: no '$Property'" -ForegroundColor Green
}

function Assert-CountFields {
  param(
    [object]$Object,
    [string]$Context
  )

  Assert-HasProperty $Object "signalReadyCount" $Context
  Assert-HasProperty $Object "signalBlockedCount" $Context
  Assert-HasProperty $Object "dryRunCount" $Context
  Assert-HasProperty $Object "executedCount" $Context

  Assert-DoesNotHaveProperty $Object "actionableCount" $Context
  Assert-DoesNotHaveProperty $Object "actionableSignals" $Context
}

function Assert-DecisionFields {
  param(
    [object[]]$Decisions,
    [string]$Context
  )

  if ($null -eq $Decisions -or $Decisions.Count -eq 0) {
    Write-Host "WARN [$Context]: no decisions to validate" -ForegroundColor Yellow
    return
  }

  foreach ($decision in $Decisions) {
    $decisionContext = "$Context decision $($decision.ticker)"

    Assert-HasProperty $decision "signalStatus" $decisionContext
    Assert-HasProperty $decision "executionStatus" $decisionContext
    Assert-HasProperty $decision "isSignalReady" $decisionContext
    Assert-DoesNotHaveProperty $decision "isActionable" $decisionContext
  }
}

Write-Section "Signal schema smoke test"
Write-Host "Base URL: $BaseUrl"

Write-Section "POST /api/autopilot/run-once"
$runOnce = Invoke-RestMethod -Uri "$BaseUrl/api/autopilot/run-once" -Method Post
$runOnce | Select-Object skipped, signalReadyCount, signalBlockedCount, dryRunCount, executedCount | Format-List

Assert-CountFields $runOnce "run-once response"
Assert-DecisionFields $runOnce.decisions "run-once response"

Write-Section "GET /api/autopilot/journal?limit=3"
$journal = Invoke-RestMethod -Uri "$BaseUrl/api/autopilot/journal?limit=3"
Assert-HasProperty $journal "runs" "journal response"

if ($journal.runs.Count -eq 0) {
  throw "FAIL [journal response]: no journal runs returned"
}

$latestRun = $journal.runs[0]
$latestRun |
  Select-Object timestamp, signalReadyCount, signalBlockedCount, dryRunCount, executedCount |
  Format-List

Assert-CountFields $latestRun "latest journal run"
Assert-DecisionFields $latestRun.decisions "latest journal run"

Write-Section "GET /api/autopilot/journal/summary?limit=200"
$summary = Invoke-RestMethod -Uri "$BaseUrl/api/autopilot/journal/summary?limit=200"
$summary |
  Select-Object signalReadySignals, signalBlockedSignals, dryRunSignals, executedSignals |
  Format-List

Assert-HasProperty $summary "signalReadySignals" "journal summary"
Assert-HasProperty $summary "signalBlockedSignals" "journal summary"
Assert-HasProperty $summary "dryRunSignals" "journal summary"
Assert-HasProperty $summary "executedSignals" "journal summary"

Assert-DoesNotHaveProperty $summary "actionableSignals" "journal summary"
Assert-DoesNotHaveProperty $summary "actionableCount" "journal summary"

Write-Section "Result"
Write-Host "PASS: strict signal schema is healthy." -ForegroundColor Green
