import Database from "better-sqlite3";
import path from "path";

// This creates a local file named 'trading_journal.db' in your backend folder
const dbPath = path.resolve(process.cwd(), "trading_journal.db");
const db = new Database(dbPath);

// Initialize the database table
db.exec(`
  CREATE TABLE IF NOT EXISTS trade_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    ticker TEXT,
    action TEXT,
    shares INTEGER,
    price REAL,
    context TEXT
  )
`);

export function logTrade(
  ticker: string,
  action: string,
  shares: number,
  price: number,
  context: string,
) {
  try {
    const stmt = db.prepare(
      "INSERT INTO trade_logs (ticker, action, shares, price, context) VALUES (?, ?, ?, ?, ?)",
    );
    stmt.run(ticker, action, shares, price, context);
    console.log(`[DATABASE] Logged ${action} for ${ticker} to journal.`);
  } catch (error) {
    console.error("[DATABASE] Failed to log trade:", error);
  }
}

export function getLogs(limit = 50) {
  try {
    return db
      .prepare("SELECT * FROM trade_logs ORDER BY timestamp DESC LIMIT ?")
      .all(limit);
  } catch (error) {
    console.error("[DATABASE] Failed to fetch logs:", error);
    return [];
  }
}
