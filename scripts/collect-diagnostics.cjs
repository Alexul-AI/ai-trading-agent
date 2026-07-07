#!/usr/bin/env node
/*
  Collects AI trading agent diagnostics into local files.
  Usage from repo root:
    node .\scripts\collect-diagnostics.cjs
    node .\scripts\collect-diagnostics.cjs --zip
    node .\scripts\collect-diagnostics.cjs --zip-only
    node .\scripts\collect-diagnostics.cjs --limit=500 --zip-only

  Step 70 / v5:
    - polishes diagnostics reports
    - keeps ticker-stats latest reason from newest run, not an older collected run
    - adds closest-signals-by-ticker.csv to avoid duplicated stale rows
    - adds collection metadata so report labels are clearer
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

function formatMoney(value) {
  const num = toNumber(value);
  if (num === null) return 'n/a';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPercentDecimal(value) {
  const num = toNumber(value);
  if (num === null) return 'n/a';
  return `${(num * 100).toFixed(1)}%`;
}

function parseKeyValueNumber(text, key) {
  const match = String(text || '').match(new RegExp(`${key}=(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : null;
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
    closestSetup: '',
    missingReasons: '',
    riskMaxSharesToBuy: null,
    riskSharesOwned: null,
    riskCurrentPositionValue: null,
    riskPositionCapValue: null,
    riskRemainingPositionCapacity: null,
    riskCashAllowedForBuy: null,
    riskCash: null,
    riskPrice: null,
    riskMaxPositionEquityFraction: null,
    riskMaxBuyCashFraction: null,
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

  const closestMatch = text.match(/closest (BUY|SELL) setup is not actionable: ([^.]+)\./i);
  if (closestMatch) {
    parsed.closestSetup = closestMatch[1].toUpperCase();
    parsed.missingReasons = closestMatch[2].trim();
  }

  for (const key of ['nearLowerBand', 'nearUpperBand', 'macdRising', 'macdFalling']) {
    const match = text.match(new RegExp(`${key}=(true|false)`, 'i'));
    if (match) parsed[key] = match[1].toLowerCase() === 'true';
  }

  parsed.riskMaxSharesToBuy = parseKeyValueNumber(text, 'maxSharesToBuy');
  parsed.riskSharesOwned = parseKeyValueNumber(text, 'sharesOwned');
  parsed.riskCurrentPositionValue = parseKeyValueNumber(text, 'currentPositionValue');
  parsed.riskPositionCapValue = parseKeyValueNumber(text, 'positionCapValue');
  parsed.riskRemainingPositionCapacity = parseKeyValueNumber(text, 'remainingPositionCapacity');
  parsed.riskCashAllowedForBuy = parseKeyValueNumber(text, 'cashAllowedForBuy');
  parsed.riskCash = parseKeyValueNumber(text, 'cash');
  parsed.riskPrice = parseKeyValueNumber(text, 'price');
  parsed.riskMaxPositionEquityFraction = parseKeyValueNumber(text, 'maxPositionEquityFraction');
  parsed.riskMaxBuyCashFraction = parseKeyValueNumber(text, 'maxBuyCashFraction');

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

function summarizeDecision(row) {
  if (row.executed === true) {
    return `${row.action} executed`;
  }

  if (row.isSignalReady === true) {
    return `${row.action} signal ready, not executed here`;
  }

  if (row.riskPositionCapValue !== null || row.riskCurrentPositionValue !== null) {
    const current = toNumber(row.riskCurrentPositionValue);
    const cap = toNumber(row.riskPositionCapValue);
    const ratio = current !== null && cap ? current / cap : null;
    return `Risk cap: position ${formatMoney(current)} / cap ${formatMoney(cap)}${ratio !== null ? ` (${ratio.toFixed(2)}x cap)` : ''}; remaining buy capacity ${formatMoney(row.riskRemainingPositionCapacity)}`;
  }

  if (row.closestSetup) {
    return `Closest ${row.closestSetup}: ${row.missingReasons || 'missing required setup conditions'}`;
  }

  if (row.action === 'HOLD') {
    return row.reason || 'HOLD';
  }

  return row.reason || `${row.action}`;
}

function timestampMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function compareRowsNewestFirst(a, b) {
  return (timestampMs(b.runTimestamp) || timestampMs(b.timestamp)) -
    (timestampMs(a.runTimestamp) || timestampMs(a.timestamp));
}

function getClosestRows(rows, { uniqueByTicker = false, limit = 25 } = {}) {
  const sorted = [...rows].sort((a, b) => {
    const closenessDelta = (toNumber(b.closenessScore) || 0) - (toNumber(a.closenessScore) || 0);
    if (Math.abs(closenessDelta) > 0.000001) return closenessDelta;
    return compareRowsNewestFirst(a, b);
  });

  const selected = [];
  const seenTickers = new Set();
  for (const row of sorted) {
    if (uniqueByTicker) {
      if (!row.ticker || seenTickers.has(row.ticker)) continue;
      seenTickers.add(row.ticker);
    }

    selected.push({
      ...row,
      closenessScore: Number((toNumber(row.closenessScore) || 0).toFixed(3)),
    });

    if (selected.length >= limit) break;
  }

  return selected;
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
      row.readableSummary = summarizeDecision(row);
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
        latestTimestamp: '',
        lastReason: '',
        lastReadableSummary: '',
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

    const rowTimestamp = row.runTimestamp || row.timestamp || '';
    if (!item.latestTimestamp || timestampMs(rowTimestamp) > timestampMs(item.latestTimestamp)) {
      item.latestTimestamp = rowTimestamp;
      item.lastReason = row.reason || '';
      item.lastReadableSummary = row.readableSummary || '';
    }
  }

  return Array.from(map.values()).map((item) => ({
    ...item,
    avgRsi: item.decisions ? Number((item.avgRsi / item.decisions).toFixed(2)) : null,
    maxClosenessScore: Number(item.maxClosenessScore.toFixed(3)),
  }));
}

function getLatestRowsByTicker(decisionRows) {
  const map = new Map();
  for (const row of [...decisionRows].sort(compareRowsNewestFirst)) {
    if (!row.ticker) continue;
    if (!map.has(row.ticker)) {
      map.set(row.ticker, row);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
}

function buildDecisionsReport(compact, latestRows, closestSignalsByTicker) {
  const lines = [];

  lines.push('# Latest Decision Summary');
  lines.push('');
  lines.push(`Collected at: ${compact.collectedAt}`);
  lines.push(`Market: ${compact.market.statusLabel || 'unknown'} (${compact.market.countdownLabel || 'n/a'})`);
  lines.push(`Collected latest runs: ${compact.collection && compact.collection.latestRunsCollected !== null ? compact.collection.latestRunsCollected : 'n/a'} / requested limit ${compact.collection && compact.collection.journalLimit ? compact.collection.journalLimit : 'n/a'}`);
  lines.push(`Autopilot: ${compact.autopilot.enabled ? 'ON' : 'OFF'}, running=${compact.autopilot.running}, execution=${compact.autopilot.executeTrades}`);
  lines.push(`Safety: allowBuy=${compact.autopilot.allowBuy}, allowSell=${compact.autopilot.allowSell}, orders=${compact.portfolio.ordersCount}, lastError=${compact.autopilot.lastError}`);
  lines.push('');
  lines.push('| Ticker | Action | RSI | Setup | Summary |');
  lines.push('|---|---:|---:|---|---|');
  for (const row of latestRows) {
    const setup = row.closestSetup || (row.riskPositionCapValue !== null ? 'RISK_CAP' : '');
    lines.push(`| ${row.ticker} | ${row.action} | ${row.rsi ?? ''} | ${setup} | ${String(row.readableSummary || '').replace(/\|/g, '/')} |`);
  }
  lines.push('');

  const riskRows = latestRows.filter((row) => row.riskPositionCapValue !== null || row.riskCurrentPositionValue !== null);
  if (riskRows.length) {
    lines.push('## Risk cap details');
    lines.push('');
    for (const row of riskRows) {
      const current = toNumber(row.riskCurrentPositionValue);
      const cap = toNumber(row.riskPositionCapValue);
      const ratio = current !== null && cap ? current / cap : null;
      lines.push(`- ${row.ticker}: position=${formatMoney(current)}, cap=${formatMoney(cap)}, ratio=${ratio !== null ? `${ratio.toFixed(2)}x` : 'n/a'}, remainingCapacity=${formatMoney(row.riskRemainingPositionCapacity)}, cashAllowedForBuy=${formatMoney(row.riskCashAllowedForBuy)}, sharesOwned=${row.riskSharesOwned}`);
    }
    lines.push('');
  }

  lines.push('## Closest collected decisions by ticker');
  lines.push('');
  for (const row of closestSignalsByTicker.slice(0, 10)) {
    lines.push(`- ${row.ticker}: closeness=${row.closenessScore}, ${row.readableSummary}`);
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function buildReport(compact, tickerStats, closestSignalsByTicker, latestRows) {
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
  lines.push(`- Summary runs returned by API: ${compact.journal.totalRuns}`);
  lines.push(`- Summary decisions returned by API: ${compact.journal.totalDecisions}`);
  lines.push(`- Latest runs collected in raw journal: ${compact.collection && compact.collection.latestRunsCollected !== null ? compact.collection.latestRunsCollected : 'n/a'} / requested limit ${compact.collection && compact.collection.journalLimit ? compact.collection.journalLimit : 'n/a'}`);
  lines.push(`- Latest decisions flattened locally: ${compact.collection && compact.collection.latestDecisionsCollected !== null ? compact.collection.latestDecisionsCollected : 'n/a'}`);
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
  lines.push('## Latest decision summary');
  lines.push('');
  for (const row of latestRows) {
    lines.push(`- ${row.ticker} ${row.action}: ${row.readableSummary}`);
  }
  lines.push('');
  lines.push('## Ticker stats from collected latest runs');
  lines.push('');
  for (const row of tickerStats) {
    lines.push(`- ${row.ticker}: decisions=${row.decisions}, HOLD=${row.hold}, BUY=${row.buy}, SELL=${row.sell}, signalReady=${row.signalReady}, avgRSI=${row.avgRsi}, maxCloseness=${row.maxClosenessScore}`);
  }
  lines.push('');
  lines.push('## Closest decisions by ticker');
  lines.push('');
  for (const row of closestSignalsByTicker.slice(0, 10)) {
    lines.push(`- ${row.ticker} ${row.action}: closeness=${row.closenessScore}, RSI=${row.rsi}, buyScore=${row.buyScore || ''}/${row.buyScoreRequired || ''}, sellScore=${row.sellScore || ''}/${row.sellScoreRequired || ''}, summary=${row.readableSummary}`);
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
    console.warn('Manual zip command:');
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
    'closestSetup',
    'missingReasons',
    'riskMaxSharesToBuy',
    'riskSharesOwned',
    'riskCurrentPositionValue',
    'riskPositionCapValue',
    'riskRemainingPositionCapacity',
    'riskCashAllowedForBuy',
    'riskCash',
    'riskPrice',
    'riskMaxPositionEquityFraction',
    'riskMaxBuyCashFraction',
    'closenessScore',
    'readableSummary',
    'reason',
  ];

  writeCsv(path.join(dir, 'all-decisions.csv'), decisionRows, decisionColumns);
  writeCsv(path.join(dir, 'last-decisions.csv'), decisionRows.slice(0, 5), decisionColumns);

  compact.collection = {
    journalLimit: options.journalLimit,
    latestRunsCollected: runs.length,
    latestDecisionsCollected: decisionRows.length,
  };
  writeJson(path.join(dir, 'compact.summary.json'), compact);

  const closestSignals = getClosestRows(decisionRows, { uniqueByTicker: false, limit: 25 });
  const closestSignalsByTicker = getClosestRows(decisionRows, { uniqueByTicker: true, limit: 10 });

  writeCsv(path.join(dir, 'closest-signals.csv'), closestSignals, decisionColumns);
  writeCsv(path.join(dir, 'closest-signals-by-ticker.csv'), closestSignalsByTicker, decisionColumns);

  const latestRows = getLatestRowsByTicker(decisionRows);
  writeCsv(path.join(dir, 'latest-decision-summary.csv'), latestRows, [
    'ticker',
    'action',
    'price',
    'rsi',
    'closestSetup',
    'missingReasons',
    'riskCurrentPositionValue',
    'riskPositionCapValue',
    'riskRemainingPositionCapacity',
    'readableSummary',
  ]);

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
    'latestTimestamp',
    'lastReadableSummary',
    'lastReason',
  ]);

  fs.writeFileSync(path.join(dir, 'diagnostics.report.md'), buildReport(compact, tickerStats, closestSignalsByTicker, latestRows), 'utf8');
  fs.writeFileSync(path.join(dir, 'decisions.report.md'), buildDecisionsReport(compact, latestRows, closestSignalsByTicker), 'utf8');

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
    console.log(path.join(dir, 'decisions.report.md'));
    console.log(path.join(dir, 'diagnostics.report.md'));
    console.log(path.join(dir, 'latest-decision-summary.csv'));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
