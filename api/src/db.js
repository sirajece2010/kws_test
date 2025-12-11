import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';

sqlite3.verbose();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve DB path relative to the api directory
const dbFile = process.env.DB_FILE || './data/devices.db';
const dbPath = path.resolve(path.join(__dirname, '..'), dbFile);

// Ensure parent directory exists
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// Create connection
export const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to open SQLite DB:', err);
    process.exit(1);
  }
});

// Promisified helpers
export function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
export function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
export function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// Initialize schema and seed
export async function init() {
  await run(`
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      strike TEXT,
      token TEXT NOT NULL UNIQUE,
      quantity TEXT,
      stop_loss TEXT,
      allocated_to TEXT,              -- NULL when available
      allocated_at TEXT,              -- ISO timestamp when allotted
      allocated_until TEXT,           -- ISO timestamp when to release
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token)`);

  // Seed some example devices if none exist
  const countRow = await get(`SELECT COUNT(*) AS c FROM devices`);
  if ((countRow?.c ?? 0) === 0) {
    const seed = [
      ['Raspberry Pi 4 (4GB)', 'RPI4-4001']
    ];
    for (const [symbol, token] of seed) {
      await run(`INSERT INTO devices (symbol, token) VALUES (?, ?)`, [symbol, token]);
    }
    console.log('Seeded example devices');
  }
}
