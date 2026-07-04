$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== Apply Backend SSE CORS Hardening ===" -ForegroundColor Cyan

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptPath "..")
$serverPath = Join-Path $repoRoot "backend\server.ts"

if (!(Test-Path $serverPath)) {
  throw "backend/server.ts was not found: $serverPath"
}

$server = Get-Content -Path $serverPath -Raw

if ($server.Contains("resolveAllowedCorsOrigin") -and !$server.Contains('res.setHeader("Access-Control-Allow-Origin", "*");')) {
  Write-Host "SSE CORS hardening already appears to be applied." -ForegroundColor Yellow
  exit 0
}

if (!$server.Contains("function parseCorsOrigins")) {
  throw "parseCorsOrigins helper was not found. Apply backend CORS hardening first."
}

$helperMarker = @'
function parseCorsOrigins(value: string): string[] {
  return value.split(",").map(normalizeCorsOrigin).filter(Boolean);
}
'@

$helperReplacement = @'
function parseCorsOrigins(value: string): string[] {
  return value.split(",").map(normalizeCorsOrigin).filter(Boolean);
}

function resolveAllowedCorsOrigin(
  origin: string | undefined,
  allowedOrigins: string[],
): string | null {
  if (!origin) return null;

  const normalizedOrigin = normalizeCorsOrigin(origin);

  return allowedOrigins.includes(normalizedOrigin) ? normalizedOrigin : null;
}
'@

if (!$server.Contains("function resolveAllowedCorsOrigin")) {
  if (!$server.Contains($helperMarker)) {
    throw "Could not find parseCorsOrigins helper block."
  }

  $server = $server.Replace($helperMarker, $helperReplacement)
}

$oldSseHeader = '  res.setHeader("Access-Control-Allow-Origin", "*");'

$newSseHeader = @'
  const sseAllowedOrigin = resolveAllowedCorsOrigin(
    typeof req.headers.origin === "string" ? req.headers.origin : undefined,
    allowedCorsOrigins,
  );

  if (sseAllowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", sseAllowedOrigin);
    res.setHeader("Vary", "Origin");
  }
'@

if (!$server.Contains($oldSseHeader)) {
  throw "Could not find old SSE wildcard Access-Control-Allow-Origin header."
}

$server = $server.Replace($oldSseHeader, $newSseHeader)

if ($server.Contains('res.setHeader("Access-Control-Allow-Origin", "*");')) {
  throw "Wildcard SSE CORS header is still present after patch."
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = "$serverPath.bak-sse-cors-$timestamp"

Copy-Item -Path $serverPath -Destination $backupPath
Set-Content -Path $serverPath -Value $server -Encoding UTF8

Write-Host "OK   Backup created: $backupPath" -ForegroundColor Green
Write-Host "OK   backend/server.ts updated with SSE CORS allowlist" -ForegroundColor Green
Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  cd backend"
Write-Host "  npm run build"
Write-Host ""
Write-Host "Then restart backend and run:" -ForegroundColor Cyan
Write-Host "  cd .."
Write-Host "  .\scripts\check-deploy-readiness.ps1"
