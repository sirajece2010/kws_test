import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.CAS_PGHOST || 'localhost',
  port: Number(process.env.CAS_PGPORT || 5112),
  database: process.env.CAS_PGDATABASE || 'marketdata',
  user: process.env.CAS_PGUSER || 'postgres',
  password: process.env.CAS_PGPASSWORD || 'postgres',
  max: 5,
  connectionTimeoutMillis: 3000
});

export async function getCasTicks(limit = 50) {
  const result = await pool.query(
    `SELECT time, symbol, ltp, open, high, low, close, volume, change, change_delta, volume_delta
     FROM ticks
     ORDER BY time DESC, weight DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getCasCandles(interval) {
  const result = await pool.query(
    `SELECT
       time_bucket($1::interval, "time") AS tm,
       symbol,
       open(candlestick_agg("time", ltp, volume)) AS open,
       high(candlestick_agg("time", ltp, volume)) AS high,
       low(candlestick_agg("time", ltp, volume)) AS low,
       close(candlestick_agg("time", ltp, volume)) AS close,
       volume(candlestick_agg("time", ltp, volume)) AS volume,
       MAX(weight) AS weight
     FROM ticks
     WHERE "time" > now() - '15 min'::interval
     GROUP BY tm, symbol
      ORDER BY tm DESC, weight DESC`,
    [interval]
  );
  return result.rows;
}

