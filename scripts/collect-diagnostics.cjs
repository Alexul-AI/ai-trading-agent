#!/usr/bin/env node
/*
  Collects AI trading agent diagnostics into local files.
  Usage from repo root:
    node .\scripts\collect-diagnostics.cjs
    node .\scripts\collect-diagnostics.cjs --zip
    node .\scripts\collect-diagnostics.cjs --zip-only
    node .\scripts\collect-diagnostics.cjs --limit=500 --zip-only
*/

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_BASE_URL = 'https://ai-trading-agent-i4nr.onrender.com';

function parseArgs(argv) {
  const result = {
    baseUrl: process.env.AI_TRADING_AGENT_BASE_URL || DEFAULT_BASE_URL,
    journalLimit: Number(process.env.JOURNAL_LIMIT || 200),
    zip: false,
    zipOnly: false,
  };

  for (const arg of argv) {
    if (arg === '--zip') {
      result.zip = true;
    } else if (arg === '--zip-only' || arg === '--clean') {
      result.zip = true;
      result.zipOnly = true;
    } else if (arg.startsWith('--base=')) {
      result.baseUrl = arg.slice('--base='.length).trim() || result.baseUrl;
    } else if (arg.startsWith('--limit=')) {
      const parsed = Number(arg.slice('--limit='.length));
      if (Number.isFinite(parsed) && parsed > 0) result.journalLimit = parsed;
    }
  }

  if (!Number.isFinite(result.journalLimit) || result.journalLimit <= 0) {
    result.journalLimit = 200;
  }

  result.baseUrl = result.baseUrl.replace(/\/$/, '');
  return result;
}

function timestampForPath(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function get(obj, pathParts, fallback = null) {
  let current = obj;
  for (const part of pathParts) {
    if (current === null || current === undefined) return fallback;
    current = current[part];
  }
  return current === undefined ? fallback : current;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseReason(reason) {
  const text = String(reason || '');
  const parsed = {
    buyScore: null,
    buyScoreRequired: null,
    sellScore: null,
    sellScoreRequired: null,
    nearLowerBand: null,
    nearUpperBand: null,
    macdRising: null,
    macdFalling: null,
  };

  const buyMatch = text.match(/buyScore=(\d+)\/(\d+)/);
  if (buyMatch) {
    parsed.buyScore = Number(buyMatch[1]);
    parsed.buyScoreRequired = Number(buyMatch[2]);
  }

  const sellMatch = text.match(/sellScore=(\d+)\/(\d+)/);
  if (sellMatch) {
    parsed.sellScore = Number(sellMatch[1]);
    parsed.sellScoreRequired = Number(sellMatch[2]);
  }

  for (const key of ['nearLowerBand', 'nearUpperBand', 'macdRising', 'macdFalling']) {
    const match = text.match(new RegExp(`${key}=(true|false)`, 'i'));
    if (match) parsed[key] = match[1].toLowerCase() === 'true';
  }

  return parsed;
}

function scoreCloseness(row) {
  const buyScore = toNumber(row.buyScore);
  const buyRequired = toNumber(row.buyScoreRequired);
  const sellScore = toNumber(row.sellScore);
  const sellRequired = toNumber(row.sellScoreRequired);

  const buyRatio = buyScore !== null && buyRequired ? buyScore / buyRequired : 0;
  const sellRatio = sellScore !== null && sellRequired ? sellScore / sellRequired : 0;

  return Math.max(buyRatio, sellRatio);
}

async function fetchJson(baseUrl, endpoint) {
  const url = `${baseUrl}${endpoint}`;
  const response = await fetch(url, { cache: 'no-store' });
  const text = await response.text();

  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`${endpoint} returned non-JSON (${response.status}): ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && parsed.error ? parsed.error : response.statusText;
    throw new Error(`${endpoint} failed with ${response.status}: ${message}`);
  }

  return parsed;
}

async function saveEndpoint(baseUrl, rawDir, name, endpoint) {
  process.stdout.write(`Fetching ${endpoint} -> raw/${name}\n`);
  try {
    const value = await fetchJson(baseUrl, endpoint);
    writeJson(path.join(rawDir, name), value);
    return value;
  } catch (error) {
    const payload = {
      endpoint,
      error: error instanceof Error ? error.message : String(error),
      collectedAt: new Date().toISOString(),
    };
    writeJson(path.join(rawDir, name), payload);
    return payload;
  }
}

function flattenJournalDecisions(journalLatest) {
  const rows = [];
  const runs = Array.isArray(journalLatest && journalLatest.runs) ? journalLatest.runs : [];

  for (const run of runs) {
    const decisions = Array.isArray(run.decisions) ? run.decisions : [];
    for (const decision of decisions) {
      const reason = decision.reason || '';
      const parsedReason = parseReason(reason);
      const row = {
        runId: run.id || '',
        runTimestamp: run.timestamp || '',
        trigger: run.trigger || '',
        runEnabled: run.enabled,
        executeTrades: run.executeTrades,
        tradeMode: run.tradeMode || '',
        ticker: decision.ticker || '',
        timestamp: decision.timestamp || '',
        price: decision.price,
        rsi: decision.rsi,
        macdHistogram: decision.macdHistogram,
        previousMacdHistogram: decision.previousMacdHistogram,
        bollingerLower: decision.bollingerLower,
        bollingerUpper: decision.bollingerUpper,
        action: decision.action || '',
        confidence: decision.confidence,
        suggestedShares: decision.suggestedShares,
        reasonType: decision.reasonType || '',
        finalStatus: decision.finalStatus || '',
        signalStatus: decision.signalStatus || '',
        executionStatus: decision.executionStatus || '',
        isSignalReady: decision.isSignalReady,
        executed: decision.executed,
        reason,
        ...parsedReason,
      };
      row.closenessScore = scoreCloseness(row);
      rows.push(row);
    }
  }

  return rows;
}

function buildCompactSummary({ baseUrl, health, clock, status, dashboard, journalSummary }) {
  return {
    collectedAt: new Date().toISOString(),
    baseUrl,
    market: {
      isOpen: get(clock, ['isOpen']),
      statusLabel: get(clock, ['statusLabel']),
      nextCloseIsrael: get(clock, ['nextCloseIsrael']),
      countdownLabel: get(clock, ['countdownLabel']),
      source: get(clock, ['source']),
    },
    autopilot: {
      enabled: get(status, ['enabled']),
      running: get(status, ['running']),
      executeTrades: get(status, ['executeTrades']),
      allowBuy: get(status, ['allowBuy']),
      allowSell: get(status, ['allowSell']),
      tradeMode: get(status, ['tradeMode']),
      strategyVersion: get(status, ['strategyVersion']),
      strategyConfigHash: get(status, ['strategyConfigHash']),
      lastRunAt: get(status, ['lastRunAt']),
      lastError: get(status, ['lastError']),
      lastJournalRunId: get(status, ['lastJournalRunId']),
      tickers: get(status, ['tickers'], []),
    },
    journal: {
      totalRuns: get(journalSummary, ['totalRuns']),
      totalDecisions: get(journalSummary, ['totalDecisions']),
      signalReadySignals: get(journalSummary, ['signalReadySignals']),
      signalBlockedSignals: get(journalSummary, ['signalBlockedSignals']),
      dryRunSignals: get(journalSummary, ['dryRunSignals']),
      executedSignals: get(journalSummary, ['executedSignals']),
      byAction: get(journalSummary, ['byAction'], {}),
      byTicker: get(journalSummary, ['byTicker'], {}),
      byReasonType: get(journalSummary, ['byReasonType'], {}),
      lastRunAt: get(journalSummary, ['lastRunAt']),
    },
    portfolio: {
      equity: get(dashboard, ['portfolio', 'equity']),
      cash: get(dashboard, ['portfolio', 'balance']),
      currency: get(dashboard, ['portfolio', 'currency']),
      positions: get(dashboard, ['portfolio', 'positions'], {}),
      ordersCount: Array.isArray(dashboard && dashboard.orders) ? dashboard.orders.length : null,
    },
    health: get(dashboard, ['health'], { ok: get(health, ['ok']), warnings: [] }),
  };
}

function groupByTicker(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.ticker || 'UNKNOWN';
    if (!map.has(key)) {
      map.set(key, {
        ticker: key,
        decisions: 0,
        hold: 0,
        buy: 0,
        sell: 0,
        signalReady: 0,
        executed: 0,
        avgRsi: 0,
        maxClosenessScore: 0,
        lastReason: '',
      });
    }
    const item = map.get(key);
    item.decisions += 1;
    if (row.action === 'HOLD') item.hold += 1;
    if (row.action === 'BUY') item.buy += 1;
    if (row.action === 'SELL') item.sell += 1;
    if (row.isSignalReady === true) item.signalReady += 1;
    if (row.executed === true) item.executed += 1;
    const rsi = toNumber(row.rsi);
    if (rsi !== null) item.avgRsi += rsi;
    item.maxClosenessScore = Math.max(item.maxClosenessScore, toNumber(row.closenessScore) || 0);
    item.lastReason = row.reason || item.lastReason;
  }

  return Array.from(map.values()).map((item) => ({
    ...item,
    avgRsi: item.decisions ? Number((item.avgRsi / item.decisions).toFixed(2)) : null,
    maxClosenessScore: Number(item.maxClosenessScore.toFixed(3)),
  }));
}

function buildReport(compact, tickerStats, closestSignals) {
  const byAction = compact.journal.byAction || {};
  const byReasonType = compact.journal.byReasonType || {};
  const lines = [];

  lines.push('# AI Trading Agent Diagnostics Report');
  lines.push('');
  lines.push(`Collected at: ${compact.collectedAt}`);
  lines.push(`Base URL: ${compact.baseUrl}`);
  lines.push('');
  lines.push('## Safety state');
  lines.push('');
  lines.push(`- Market: ${compact.market.statusLabel || 'unknown'} (${compact.market.countdownLabel || 'n/a'} until next event)`);
  lines.push(`- Trade mode: ${compact.autopilot.tradeMode}`);
  lines.push(`- Autopilot enabled: ${compact.autopilot.enabled}`);
  lines.push(`- Running now: ${compact.autopilot.running}`);
  lines.push(`- Execute trades: ${compact.autopilot.executeTrades}`);
  lines.push(`- Allow buy / sell: ${compact.autopilot.allowBuy} / ${compact.autopilot.allowSell}`);
  lines.push(`- Last error: ${compact.autopilot.lastError === null ? 'null' : compact.autopilot.lastError}`);
  lines.push(`- Open orders count: ${compact.portfolio.ordersCount}`);
  lines.push(`- Health OK: ${compact.health && compact.health.ok}`);
  lines.push('');
  lines.push('## Journal summary');
  lines.push('');
  lines.push(`- Runs: ${compact.journal.totalRuns}`);
  lines.push(`- Decisions: ${compact.journal.totalDecisions}`);
  lines.push(`- Signal-ready: ${compact.journal.signalReadySignals}`);
  lines.push(`- Signal-blocked: ${compact.journal.signalBlockedSignals}`);
  lines.push(`- Dry-run candidates: ${compact.journal.dryRunSignals}`);
  lines.push(`- Executed: ${compact.journal.executedSignals}`);
  lines.push(`- By action: ${JSON.stringify(byAction)}`);
  lines.push(`- By reason type: ${JSON.stringify(byReasonType)}`);
  lines.push('');
  lines.push('## Portfolio');
  lines.push('');
  lines.push(`- Equity: ${compact.portfolio.equity} ${compact.portfolio.currency || ''}`.trim());
  lines.push(`- Cash: ${compact.portfolio.cash} ${compact.portfolio.currency || ''}`.trim());
  lines.push(`- Positions: ${JSON.stringify(compact.portfolio.positions || {})}`);
  lines.push('');
  lines.push('## Ticker stats from collected latest runs');
  lines.push('');
  for (const row of tickerStats) {
    lines.push(`- ${row.ticker}: decisions=${row.decisions}, HOLD=${row.hold}, BUY=${row.buy}, SELL=${row.sell}, signalReady=${row.signalReady}, avgRSI=${row.avgRsi}, maxCloseness=${row.maxClosenessScore}`);
  }
  lines.push('');
  lines.push('## Closest latest decisions');
  lines.push('');
  for (const row of closestSignals.slice(0, 10)) {
    lines.push(`- ${row.ticker} ${row.action}: closeness=${row.closenessScore}, RSI=${row.rsi}, buyScore=${row.buyScore || ''}/${row.buyScoreRequired || ''}, sellScore=${row.sellScore || ''}/${row.sellScoreRequired || ''}, reason=${row.reason}`);
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function tryCreateZip(dir, zipPath) {
  const command = `$ErrorActionPreference = 'Stop'; Compress-Archive -Path '${dir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    const details = result.error ? result.error.message : result.stderr;
    console.warn(`Could not create zip automatically: ${details}`);
    console.warn(`Manual zip command:`);
    console.warn(`Compress-Archive -Path "${dir}\\*" -DestinationPath "${zipPath}" -Force`);
    return false;
  }

  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const stamp = timestampForPath();
  const diagnosticsRoot = path.join(repoRoot, 'diagnostics');
  const dir = path.join(diagnosticsRoot, stamp);
  const rawDir = path.join(dir, 'raw');

  fs.mkdirSync(rawDir, { recursive: true });

  const health = await saveEndpoint(options.baseUrl, rawDir, 'health.deep.json', '/api/health?deep=true');
  const clock = await saveEndpoint(options.baseUrl, rawDir, 'market.clock.json', '/api/market/clock');
  const status = await saveEndpoint(options.baseUrl, rawDir, 'autopilot.status.json', '/api/autopilot/status');
  const dashboard = await saveEndpoint(options.baseUrl, rawDir, 'dashboard.json', '/api/dashboard');
  const journalLatest = await saveEndpoint(options.baseUrl, rawDir, 'journal.latest.json', `/api/autopilot/journal?limit=${options.journalLimit}`);
  const journalSummary = await saveEndpoint(options.baseUrl, rawDir, 'journal.summary.json', `/api/autopilot/journal/summary?limit=${options.journalLimit}`);

  const compact = buildCompactSummary({
    baseUrl: options.baseUrl,
    health,
    clock,
    status,
    dashboard,
    journalSummary,
  });

  writeJson(path.join(dir, 'compact.summary.json'), compact);

  const runs = Array.isArray(journalLatest && journalLatest.runs) ? journalLatest.runs : [];
  const runRows = runs.map((run) => ({
    id: run.id || '',
    timestamp: run.timestamp || '',
    trigger: run.trigger || '',
    enabled: run.enabled,
    executeTrades: run.executeTrades,
    tradeMode: run.tradeMode || '',
    signalReadyCount: run.signalReadyCount,
    signalBlockedCount: run.signalBlockedCount,
    dryRunCount: run.dryRunCount,
    executedCount: run.executedCount,
    strategyVersion: run.strategyVersion || '',
    strategyConfigHash: run.strategyConfigHash || '',
  }));

  writeCsv(path.join(dir, 'journal-runs.csv'), runRows, [
    'id',
    'timestamp',
    'trigger',
    'enabled',
    'executeTrades',
    'tradeMode',
    'signalReadyCount',
    'signalBlockedCount',
    'dryRunCount',
    'executedCount',
    'strategyVersion',
    'strategyConfigHash',
  ]);

  const decisionRows = flattenJournalDecisions(journalLatest);
  const decisionColumns = [
    'runId',
    'runTimestamp',
    'trigger',
    'runEnabled',
    'executeTrades',
    'tradeMode',
    'ticker',
    'timestamp',
    'price',
    'rsi',
    'macdHistogram',
    'previousMacdHistogram',
    'bollingerLower',
    'bollingerUpper',
    'action',
    'confidence',
    'suggestedShares',
    'reasonType',
    'finalStatus',
    'signalStatus',
    'executionStatus',
    'isSignalReady',
    'executed',
    'buyScore',
    'buyScoreRequired',
    'sellScore',
    'sellScoreRequired',
    'nearLowerBand',
    'nearUpperBand',
    'macdRising',
    'macdFalling',
    'closenessScore',
    'reason',
  ];

  writeCsv(path.join(dir, 'all-decisions.csv'), decisionRows, decisionColumns);
  writeCsv(path.join(dir, 'last-decisions.csv'), decisionRows.slice(0, 5), decisionColumns);

  const closestSignals = [...decisionRows]
    .sort((a, b) => (toNumber(b.closenessScore) || 0) - (toNumber(a.closenessScore) || 0))
    .slice(0, 25)
    .map((row) => ({
      ...row,
      closenessScore: Number((toNumber(row.closenessScore) || 0).toFixed(3)),
    }));

  writeCsv(path.join(dir, 'closest-signals.csv'), closestSignals, decisionColumns);

  const tickerStats = groupByTicker(decisionRows).sort((a, b) => a.ticker.localeCompare(b.ticker));
  writeCsv(path.join(dir, 'ticker-stats.csv'), tickerStats, [
    'ticker',
    'decisions',
    'hold',
    'buy',
    'sell',
    'signalReady',
    'executed',
    'avgRsi',
    'maxClosenessScore',
    'lastReason',
  ]);

  fs.writeFileSync(path.join(dir, 'diagnostics.report.md'), buildReport(compact, tickerStats, closestSignals), 'utf8');

  const zipPath = `${dir}.zip`;
  let zipCreated = false;
  if (options.zip) {
    zipCreated = tryCreateZip(dir, zipPath);
  }

  if (options.zipOnly && zipCreated) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('');
  console.log('Diagnostics created:');
  if (!options.zipOnly || !zipCreated) {
    console.log(dir);
  }
  if (options.zip && zipCreated) {
    console.log(zipPath);
  }
  if (options.zipOnly && zipCreated) {
    console.log('');
    console.log('Zip-only mode: temporary diagnostics folder was removed.');
  }
  console.log('');
  console.log('Most useful files:');
  if (options.zip && zipCreated) {
    console.log(zipPath);
  } else {
    console.log(path.join(dir, 'compact.summary.json'));
    console.log(path.join(dir, 'diagnostics.report.md'));
    console.log(path.join(dir, 'closest-signals.csv'));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
