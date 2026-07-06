param(
    [string]$BaseUrl = "https://ai-trading-agent-i4nr.onrender.com",
    [string]$OutputRoot = ".\diagnostics",
    [int]$LatestLimit = 10,
    [int]$SummaryLimit = 500,
    [switch]$NoZip
)

$ErrorActionPreference = "Stop"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dir = Join-Path $OutputRoot $stamp
$rawDir = Join-Path $dir "raw"

New-Item -ItemType Directory -Path $rawDir -Force | Out-Null

function Save-Endpoint {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $target = Join-Path $rawDir $Name
    $url = "$BaseUrl$Path"
    Write-Host "Fetching $url -> $target"

    try {
        $data = Invoke-RestMethod $url
        $data | ConvertTo-Json -Depth 80 | Set-Content $target -Encoding UTF8
        return $data
    }
    catch {
        $errorObject = [pscustomobject]@{
            endpoint = $Path
            url = $url
            error = $_.Exception.Message
            collectedAt = (Get-Date).ToString("o")
        }
        $errorObject | ConvertTo-Json -Depth 20 | Set-Content $target -Encoding UTF8
        Write-Warning "Failed to fetch ${Path}: $($_.Exception.Message)"
        return $null
    }
}

$health = Save-Endpoint "health.deep.json" "/api/health?deep=true"
$clock = Save-Endpoint "market.clock.json" "/api/market/clock"
$status = Save-Endpoint "autopilot.status.json" "/api/autopilot/status"
$dashboard = Save-Endpoint "dashboard.json" "/api/dashboard"
$journalLatest = Save-Endpoint "journal.latest.json" "/api/autopilot/journal?limit=$LatestLimit"
$journalSummary = Save-Endpoint "journal.summary.json" "/api/autopilot/journal/summary?limit=$SummaryLimit"

$positions = @{}
$ordersCount = $null
if ($dashboard -and $dashboard.portfolio) {
    $positions = $dashboard.portfolio.positions
}
if ($dashboard -and $null -ne $dashboard.orders) {
    $ordersCount = @($dashboard.orders).Count
}

$compact = [pscustomobject]@{
    collectedAt = (Get-Date).ToString("o")
    baseUrl = $BaseUrl
    market = if ($clock) {
        [pscustomobject]@{
            isOpen = $clock.isOpen
            statusLabel = $clock.statusLabel
            nextCloseIsrael = $clock.nextCloseIsrael
            countdownLabel = $clock.countdownLabel
            source = $clock.source
        }
    } else { $null }
    autopilot = if ($status) {
        [pscustomobject]@{
            enabled = $status.enabled
            running = $status.running
            executeTrades = $status.executeTrades
            allowBuy = $status.allowBuy
            allowSell = $status.allowSell
            tradeMode = $status.tradeMode
            strategyVersion = $status.strategyVersion
            strategyConfigHash = $status.strategyConfigHash
            lastRunAt = $status.lastRunAt
            lastError = $status.lastError
            lastJournalRunId = $status.lastJournalRunId
            tickers = $status.tickers
        }
    } else { $null }
    journal = if ($journalSummary) {
        [pscustomobject]@{
            totalRuns = $journalSummary.totalRuns
            totalDecisions = $journalSummary.totalDecisions
            signalReadySignals = $journalSummary.signalReadySignals
            signalBlockedSignals = $journalSummary.signalBlockedSignals
            dryRunSignals = $journalSummary.dryRunSignals
            executedSignals = $journalSummary.executedSignals
            byAction = $journalSummary.byAction
            byTicker = $journalSummary.byTicker
            byReasonType = $journalSummary.byReasonType
            lastRunAt = $journalSummary.lastRunAt
        }
    } else { $null }
    portfolio = if ($dashboard -and $dashboard.portfolio) {
        [pscustomobject]@{
            equity = $dashboard.portfolio.equity
            cash = $dashboard.portfolio.balance
            currency = $dashboard.portfolio.currency
            positions = $positions
            ordersCount = $ordersCount
        }
    } else { $null }
    health = if ($dashboard) { $dashboard.health } else { $null }
}

$compactPath = Join-Path $dir "compact.summary.json"
$compact | ConvertTo-Json -Depth 80 | Set-Content $compactPath -Encoding UTF8

if ($status -and $status.lastDecisions) {
    $status.lastDecisions |
        Select-Object ticker,timestamp,price,rsi,macdHistogram,previousMacdHistogram,bollingerLower,bollingerUpper,action,confidence,suggestedShares,reasonType,finalStatus,signalStatus,executionStatus,isSignalReady,executed,reason |
        Export-Csv (Join-Path $dir "last-decisions.csv") -NoTypeInformation -Encoding UTF8
}

if ($journalLatest -and $journalLatest.runs) {
    $journalLatest.runs |
        Select-Object id,timestamp,trigger,enabled,executeTrades,tradeMode,signalReadyCount,signalBlockedCount,dryRunCount,executedCount,strategyVersion,strategyConfigHash |
        Export-Csv (Join-Path $dir "journal-runs.csv") -NoTypeInformation -Encoding UTF8
}

$zipPath = Join-Path $OutputRoot "$stamp.zip"
if (-not $NoZip) {
    Compress-Archive -Path (Join-Path $dir "*") -DestinationPath $zipPath -Force
}

Write-Host ""
Write-Host "Diagnostics collected:"
Write-Host "Folder: $dir"
if (-not $NoZip) {
    Write-Host "Zip:    $zipPath"
}
Write-Host "Compact summary: $compactPath"

