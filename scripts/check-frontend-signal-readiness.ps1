param(
  [string]$FrontendRoot = ""
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== Frontend safety utilities audit ===" -ForegroundColor Cyan

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptPath "..")

if ([string]::IsNullOrWhiteSpace($FrontendRoot)) {
  $FrontendRoot = Join-Path $repoRoot "frontend"
}

$srcRoot = Join-Path $FrontendRoot "src"
$signalUtilityPath = Join-Path $srcRoot "utils\signalReadiness.ts"
$orderPreviewUtilityPath = Join-Path $srcRoot "utils\orderPreview.ts"

if (!(Test-Path $srcRoot)) {
  throw "Frontend src folder was not found: $srcRoot"
}

if (!(Test-Path $signalUtilityPath)) {
  throw "Missing central signal readiness utility: $signalUtilityPath"
}

if (!(Test-Path $orderPreviewUtilityPath)) {
  throw "Missing central order preview utility: $orderPreviewUtilityPath"
}

Write-Host "Frontend root: $FrontendRoot"
Write-Host "Signal utility: $signalUtilityPath"
Write-Host "Order preview utility: $orderPreviewUtilityPath"

$files = Get-ChildItem -Path $srcRoot -Recurse -Include *.ts,*.tsx |
  Where-Object {
    $_.FullName -notmatch "\\node_modules\\" -and
    $_.FullName -notmatch "\\dist\\" -and
    $_.FullName -notmatch "\\utils\\signalReadiness\.ts$" -and
    $_.FullName -notmatch "\\utils\\orderPreview\.ts$"
  }

$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
  param(
    [string]$File,
    [int]$LineNumber,
    [string]$Rule,
    [string]$Line
  )

  $failures.Add("${File}:${LineNumber} [$Rule] $Line") | Out-Null
}

function Test-ForbiddenPattern {
  param(
    [string]$Pattern,
    [string]$Rule
  )

  foreach ($file in $files) {
    $matches = Select-String -Path $file.FullName -Pattern $Pattern -SimpleMatch -ErrorAction SilentlyContinue

    foreach ($match in $matches) {
      Add-Failure `
        -File ($file.FullName.Replace("$repoRoot\", "")) `
        -LineNumber $match.LineNumber `
        -Rule $Rule `
        -Line $match.Line.Trim()
    }
  }
}

function Test-ForbiddenRegex {
  param(
    [string]$Pattern,
    [string]$Rule
  )

  foreach ($file in $files) {
    $matches = Select-String -Path $file.FullName -Pattern $Pattern -ErrorAction SilentlyContinue

    foreach ($match in $matches) {
      Add-Failure `
        -File ($file.FullName.Replace("$repoRoot\", "")) `
        -LineNumber $match.LineNumber `
        -Rule $Rule `
        -Line $match.Line.Trim()
    }
  }
}

Write-Host ""
Write-Host "Checking forbidden legacy schema fields..." -ForegroundColor Cyan

Test-ForbiddenPattern -Pattern "isActionable" -Rule "legacy isActionable must only live in utils/signalReadiness.ts"
Test-ForbiddenPattern -Pattern "actionableCount" -Rule "old actionableCount alias is forbidden"
Test-ForbiddenPattern -Pattern "actionableSignals" -Rule "old actionableSignals alias is forbidden"

Write-Host "Checking forbidden local readiness helper definitions..." -ForegroundColor Cyan

Test-ForbiddenRegex -Pattern "\b(function|const)\s+isSignalReadyDecision\b" -Rule "use central isSignalReadyDecision from utils/signalReadiness.ts"
Test-ForbiddenRegex -Pattern "\b(function|const)\s+isBuySellSignal\b" -Rule "use central isBuySellSignal from utils/signalReadiness.ts"
Test-ForbiddenRegex -Pattern "\b(function|const)\s+isExecutionOnlySkippedReason\b" -Rule "use central isExecutionOnlySkippedReason from utils/signalReadiness.ts"
Test-ForbiddenRegex -Pattern "\b(function|const)\s+getLatestSignalReadyDecision\b" -Rule "use central getLatestSignalReadyDecision from utils/signalReadiness.ts"

Write-Host "Checking forbidden local order-preview helper definitions..." -ForegroundColor Cyan

Test-ForbiddenRegex -Pattern "\b(function|const)\s+buildOrderPreviewPlan\b" -Rule "use central buildOrderPreviewPlan from utils/orderPreview.ts"
Test-ForbiddenRegex -Pattern "\b(function|const)\s+toBrokerSide\b" -Rule "use central toBrokerSide through utils/orderPreview.ts"

Write-Host "Checking expected central utility exports..." -ForegroundColor Cyan

$utilityContent = Get-Content -Path $signalUtilityPath -Raw
$requiredExports = @(
  "export function isBuySellSignal",
  "export function isExecutionOnlySkippedReason",
  "export function isSignalReadyDecision",
  "export function getSignalReadyDecisions",
  "export function getLatestSignalReadyDecision",
  "export function countSignalReadyDecisions",
  "export function countSignalBlockedDecisions"
)

foreach ($requiredExport in $requiredExports) {
  if (!$utilityContent.Contains($requiredExport)) {
    $failures.Add("utils/signalReadiness.ts [missing export] $requiredExport") | Out-Null
  }
}

$orderPreviewContent = Get-Content -Path $orderPreviewUtilityPath -Raw
$orderPreviewRequiredExports = @(
  "export function buildOrderPreviewPlan",
  "export interface OrderPreviewPlan",
  "export interface SafeTradeCallPreview",
  "export interface BrokerStylePayloadPreview"
)

foreach ($requiredExport in $orderPreviewRequiredExports) {
  if (!$orderPreviewContent.Contains($requiredExport)) {
    $failures.Add("utils/orderPreview.ts [missing export] $requiredExport") | Out-Null
  }
}

Write-Host "Checking expected consumers import the central utility..." -ForegroundColor Cyan

$expectedConsumers = @(
  "App.tsx",
  "components\ExecutionReadinessPanel.tsx",
  "components\ActionableSignalDebugPanel.tsx",
  "components\StrategyComparisonPanel.tsx",
  "components\StrategyQualityPanel.tsx",
  "components\DecisionJournalPanel.tsx",
  "components\TickerChartPanel.tsx"
)

foreach ($consumer in $expectedConsumers) {
  $path = Join-Path $srcRoot $consumer

  if (!(Test-Path $path)) {
    $failures.Add("$consumer [missing file] Expected consumer file was not found") | Out-Null
    continue
  }

  $content = Get-Content -Path $path -Raw

  if (!$content.Contains("utils/signalReadiness") -and !$content.Contains("../utils/signalReadiness") -and !$content.Contains("./utils/signalReadiness")) {
    $failures.Add("$consumer [missing import] Does not import central signalReadiness utility") | Out-Null
  }
}

$executionReadinessPath = Join-Path $srcRoot "components\ExecutionReadinessPanel.tsx"
if (Test-Path $executionReadinessPath) {
  $executionReadinessContent = Get-Content -Path $executionReadinessPath -Raw

  if (!$executionReadinessContent.Contains("../utils/orderPreview")) {
    $failures.Add("components\ExecutionReadinessPanel.tsx [missing import] Does not import central orderPreview utility") | Out-Null
  }
}

Write-Host ""
if ($failures.Count -eq 0) {
  Write-Host "PASS: frontend safety utility logic is centralized." -ForegroundColor Green
  exit 0
}

Write-Host "FAIL: frontend signal readiness audit found issues:" -ForegroundColor Red
foreach ($failure in $failures) {
  Write-Host " - $failure" -ForegroundColor Red
}

exit 1
