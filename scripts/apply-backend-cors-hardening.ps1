$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== Apply Backend CORS Hardening ===" -ForegroundColor Cyan

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptPath "..")
$serverPath = Join-Path $repoRoot "backend\server.ts"

if (!(Test-Path $serverPath)) {
  throw "backend/server.ts was not found: $serverPath"
}

$server = Get-Content -Path $serverPath -Raw

if ($server.Contains("function parseCorsOrigins") -and $server.Contains("allowedCorsOrigins")) {
  Write-Host "CORS hardening already appears to be applied." -ForegroundColor Yellow
  exit 0
}

$helperMarker = "const ENV = envParse.data;"
$helperBlock = @'
const ENV = envParse.data;

function normalizeCorsOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

function parseCorsOrigins(value: string): string[] {
  return value
    .split(",")
    .map(normalizeCorsOrigin)
    .filter(Boolean);
}
'@

if (!$server.Contains($helperMarker)) {
  throw "Could not find helper insertion marker: $helperMarker"
}

$server = $server.Replace($helperMarker, $helperBlock)

$oldCors = @'
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);
'@

$newCors = @'
const allowedCorsOrigins = parseCorsOrigins(ENV.FRONTEND_ORIGIN);

if (allowedCorsOrigins.length === 0) {
  console.error("[ENV] FRONTEND_ORIGIN must contain at least one origin.");
  process.exit(1);
}

app.use(
  cors({
    origin(
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) {
      if (!origin) {
        callback(null, true);
        return;
      }

      const normalizedOrigin = normalizeCorsOrigin(origin);

      if (allowedCorsOrigins.includes(normalizedOrigin)) {
        callback(null, true);
        return;
      }

      console.warn(`[CORS] Blocked origin: ${origin}`);
      callback(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);
'@

if (!$server.Contains($oldCors)) {
  throw "Could not find old wildcard CORS block. server.ts may have changed; patch manually."
}

$server = $server.Replace($oldCors, $newCors)

$listenMarker = '  console.log(`[SERVER] Frontend origin: ${ENV.FRONTEND_ORIGIN}`);'
$listenReplacement = @'
  console.log(`[SERVER] Frontend origin: ${ENV.FRONTEND_ORIGIN}`);
  console.log(`[SERVER] Allowed CORS origins: ${allowedCorsOrigins.join(", ")}`);
'@

if ($server.Contains($listenMarker)) {
  $server = $server.Replace($listenMarker, $listenReplacement)
} else {
  Write-Host "WARN Could not find listen log marker. CORS hardening was applied, but log line was not added." -ForegroundColor Yellow
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = "$serverPath.bak-cors-$timestamp"

Copy-Item -Path $serverPath -Destination $backupPath
Set-Content -Path $serverPath -Value $server -Encoding UTF8

Write-Host "OK   Backup created: $backupPath" -ForegroundColor Green
Write-Host "OK   backend/server.ts updated with CORS allowlist" -ForegroundColor Green
Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  cd backend"
Write-Host "  npm run build"
Write-Host ""
Write-Host "FRONTEND_ORIGIN now supports comma-separated origins, for example:" -ForegroundColor Cyan
Write-Host "  FRONTEND_ORIGIN=http://localhost:5173,https://your-frontend-domain.com"
