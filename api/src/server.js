import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { init, all, get, run } from './db.js';

const app = express();
app.use(morgan('dev'));
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
//app.use(express.static(path.join(__dirname, '../../public')));

const publicDir = path.resolve(__dirname, '../../public');
console.log('Serving static from:', publicDir); // <-- add this for debug
app.use(express.static(publicDir))


await init();

// Health check
app.get('/api/health', async (_req, res) => {
  try {
    await get('SELECT 1 AS ok');
    res.json({ status: 'ok', db: 'connected' });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// -------- Devices CRUD --------

// List all devices
app.get('/api/devices', async (_req, res, next) => {
  try {
    const rows = await all(`
      SELECT id, symbol, token, strike, quantity, stop_loss, allocated_to, allocated_at, allocated_until, created_at
      FROM devices
      ORDER BY id ASC
    `);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Get one device
app.get('/api/devices/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });

    const row = await get(`SELECT * FROM devices WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Create device
app.post('/api/devices', async (req, res, next) => {
  try {
    const { symbol, token, strike, quantity} = req.body;
    if (typeof symbol !== 'string' || !symbol.trim()) {
      return res.status(400).json({ error: 'symbol is required' });
    }
    if (typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ error: 'token is required' });
    }
    if (typeof strike !== 'string' || !strike.trim()) {
      return res.status(400).json({ error: 'strike is required' });
    }
    if (typeof quantity !== 'string' || !quantity.trim()) {
      return res.status(400).json({ error: 'quantity is either empty or not string' });
    }
    try {
      const { lastID } = await run(
        `INSERT INTO devices (symbol, token, strike, quantity) VALUES (?, ?, ?, ?)`,
        [symbol.trim(), token.trim(), strike.trim(), quantity.trim()]
      );
      const row = await get(`SELECT * FROM devices WHERE id = ?`, [lastID]);
      res.status(201).json(row);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'Token must be unique' });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// Update device (symbol/token only)
app.put('/api/devices/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { symbol, token} = req.body;

    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });
    const fields = [];
    const values = [];
    if (symbol !== undefined) {
      if (typeof symbol !== 'string' || !symbol.trim()) {
        return res.status(400).json({ error: 'symbol must be a non-empty string' });
      }
      fields.push('symbol = ?'); values.push(symbol.trim());
    }
    if (token !== undefined) {
      if (typeof token !== 'string' || !token.trim()) {
        return res.status(400).json({ error: 'token must be a non-empty string' });
      }
      fields.push('token = ?'); values.push(token.trim());
    }
    if (fields.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    values.push(id);
    try {
      const { changes } = await run(`UPDATE devices SET ${fields.join(', ')} WHERE id = ?`, values);
      if (changes === 0) return res.status(404).json({ error: 'Not found' });
      const row = await get(`SELECT * FROM devices WHERE id = ?`, [id]);
      res.json(row);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'Token must be unique' });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// Update strike
app.put('/api/devices/:id/chown', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { strike } = req.body;

    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });
    const fields = [];
    const values = [];

    if (strike !== undefined) {
      if (typeof strike !== 'string' || !strike.trim()) {
        return res.status(400).json({ error: 'strike must be a non-empty string' });
      }
      fields.push('strike = ?'); values.push(strike.trim());
    }
    if (fields.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    values.push(id);
    try {
      const { changes } = await run(`UPDATE devices SET ${fields.join(', ')} WHERE id = ?`, values);
      if (changes === 0) return res.status(404).json({ error: 'Not found' });
      const row = await get(`SELECT * FROM devices WHERE id = ?`, [id]);
      res.json(row);
    } catch (e) {
      if (String(e.message)) {
        return res.status(409).json({ error: 'Unable to update the strike' });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// -------- Allocation actions --------

// Allot device to a username
app.post('/api/devices/:id/allot', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { username } = req.body;
    const hours = '4';
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });
    if (typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'username is required' });
    }

   // Default duration = 5 hours if not provided or invalid
    const durationHours = Number.isFinite(Number(hours)) && Number(hours) > 0 ? Number(hours) : 5;

    // Only allot if currently unallocated (optimistic concurrency)
    const { changes } = await run(
      `UPDATE devices
       SET allocated_to = ?, allocated_at = datetime('now'),
       allocated_until = datetime('now', '+' || ? || ' hours')
       WHERE id = ? AND allocated_to IS NULL`,
      [username.trim(), durationHours, id]
    );
    if (changes === 0) {
      // either not found or already allocated
      const exists = await get(`SELECT id FROM devices WHERE id = ?`, [id]);
      if (!exists) return res.status(404).json({ error: 'Not found' });
      return res.status(409).json({ error: 'Device is already allocated' });
    }

    const row = await get(`SELECT * FROM devices WHERE id = ?`, [id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Release device (clear allocation)
app.post('/api/devices/:id/release', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });

    // Only release if currently allocated
    const { changes } = await run(
      `UPDATE devices
       SET allocated_to = NULL, allocated_at = NULL, allocated_until = NULL
       WHERE id = ? AND allocated_to IS NOT NULL`,
      [id]
    );
    if (changes === 0) {
      const exists = await get(`SELECT id FROM devices WHERE id = ?`, [id]);
      if (!exists) return res.status(404).json({ error: 'Not found' });
      return res.status(409).json({ error: 'Device is already available' });
    }

    const row = await get(`SELECT * FROM devices WHERE id = ?`, [id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Delete device (optional)
app.delete('/api/devices/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });
    const { changes } = await run(`DELETE FROM devices WHERE id = ?`, [id]);
    if (changes === 0) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});


// Global error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

// Start server
const port = Number(3050);
app.listen(port, () => {
  console.log(`Device Inventory listening on http://localhost:${port}`);
});
