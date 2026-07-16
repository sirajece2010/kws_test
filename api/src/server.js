import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { init, all, get, run } from './db.js';
import OTPLib from 'otplib';
import { runInThisContext } from 'vm';
import session from 'express-session';
import https from 'https';
import http from 'http';
import fs from 'fs';

const app = express();
app.use(morgan('dev'));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'kws-session-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: true, // always HTTPS
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
//app.use(express.static(path.join(__dirname, '../../public')));

const publicDir = path.resolve(__dirname, '../public');
// Dynamic public directory resolution
let publicDirResolved = publicDir;
const possiblePaths = [
  publicDir,
  path.resolve(__dirname, '../../public'),
  path.join(process.cwd(), 'public')
];

for (const dirPath of possiblePaths) {
  if (fs.existsSync(dirPath)) {
    publicDirResolved = dirPath;
    break;
  }
}
console.log('Serving static from:', publicDirResolved); // <-- add this for debug
app.use(express.static(publicDirResolved));

await init();
await downloadInstrumentsCSV(); // Download instruments CSV once at startup

// Per-user state storage (Maps indexed by userId/username)
const userPortfolios = new Map();           // userId -> portfolioId
const userPaperTradeGroups = new Map();     // userId -> paperTradeGroupId
const userAccessTokens = new Map();         // userId -> accessToken
const userSessionCookies = new Map();       // userId -> { client_info, bkd_ref }
const pendingOrders = new Map();            // userId -> Set of pending order keys (symbol_action)
const instrumentsMap = {};                  // tradingsymbol -> instrument info
let SELL_SL_PERCENT = 1.5;                  // Stop Loss percentage for SELL positions (150% of avg price)
let BUY_SL_PERCENT = 0.33;                  // Stop Loss percentage for BUY positions (33% of avg price)

function setUserSessionCookies(userId, cookies = {}) {
  if (userId) userSessionCookies.set(userId, cookies);
}
function getUserSessionCookies(userId) {
  return userId ? (userSessionCookies.get(userId) || {}) : {};
}
function buildCookie(accessToken, userId) {
  // Sensibull's oxide endpoints require their own pb: prefixed token, not the raw Kite token
  const sensibullToken = process.env.SENSIBULL_ACCESS_TOKEN || accessToken;
  const session = getUserSessionCookies(userId);
  const clientInfo = session.client_info || process.env.SENSIBULL_CLIENT_INFO || '';
  const bkdRef     = session.bkd_ref     || process.env.SENSIBULL_BKD_REF     || '';
  let extra = '';
  if (clientInfo) extra += '; client_info=' + clientInfo;
  if (bkdRef)     extra += '; bkd_ref=' + bkdRef;
  return 'access_token=' + sensibullToken + extra;
}

function sensibullHeaders(accessToken, userId) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    'Cookie': buildCookie(accessToken, userId),
    'Origin': 'https://web.sensibull.com',
    'Referer': 'https://web.sensibull.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
  };
}

// Helper functions for per-user state management
function setUserPortfolio(userId, portfolioId) {
  if (userId && portfolioId) {
    userPortfolios.set(userId, portfolioId);
    console.log(`Portfolio set for user ${userId}: ${portfolioId}`);
  }
}

function getUserPortfolio(userId) {
  return userId ? userPortfolios.get(userId) : null;
}

function setUserPaperTradeGroup(userId, groupId) {
  if (userId && groupId) {
    userPaperTradeGroups.set(userId, groupId);
    console.log(`PaperTradeGroup set for user ${userId}: ${groupId}`); // <-- add this for debug
  }
}

function getUserPaperTradeGroup(userId) {
  return userId ? userPaperTradeGroups.get(userId) : null;
}

function setUserAccessToken(userId, accessToken) {
  if (userId && accessToken) {
    userAccessTokens.set(userId, accessToken);
  }
}

function getUserAccessToken(userId) {
  return userId ? userAccessTokens.get(userId) : null;
}

function clearUserData(userId) {
  if (userId) {
    userPortfolios.delete(userId);
    userPaperTradeGroups.delete(userId);
    userAccessTokens.delete(userId);
    userSessionCookies.delete(userId);
    pendingOrders.delete(userId);
    console.log(`Cleared all data for user ${userId}`);
  }
}

// Helper functions for managing pending orders
function syncPendingOrders(userId, orders = []) {
  if (!userId) return new Set();

  const openOrderKeys = new Set(
    orders
      .filter((order) => String(order.status || '').toUpperCase() === 'OPEN')
      .map((order) => {
        const symbol = order.trading_symbol || order.symbol;
        const action = order.transaction_type || order.type;
        const quantity = order.quantity || order.qty;
        return symbol && action && quantity ? `${symbol}_${action}_${quantity}` : null;
      })
      .filter(Boolean)
  );
  // console.log(`User ${userId} - Synced pending orders:`, Array.from(openOrderKeys)); // <-- add this for debug
  if (openOrderKeys.size > 0) {
    pendingOrders.set(userId, openOrderKeys);
  } else {
    pendingOrders.delete(userId);
  }

  return openOrderKeys;
}

async function getPendingOrders(userId) {
  if (!userId) return new Set();

  const result = await Ordersmap(userId);
  return syncPendingOrders(userId, result?.orders || []);
}

function hasPendingOrder(userId, symbol, action, quantity) {
  if (!userId || !symbol || !action) return false;

  const userPendingOrders = pendingOrders.get(userId);
  if (!userPendingOrders || userPendingOrders.size === 0) return false;

  // Exact match when quantity is available.
  if (quantity !== undefined && quantity !== null) {
    const orderKey = `${symbol}_${action}_${quantity}`;
    return userPendingOrders.has(orderKey);
  }

  // Fallback: match any open order for same symbol + action from syncPendingOrders.
  const keyPrefix = `${symbol}_${action}_`;
  for (const key of userPendingOrders) {
    if (key.startsWith(keyPrefix)) {
      return true;
    }
  }

  return false;
}

// Extract userId from request header (X-User-Id) or authenticated session
function getRequestUserId(req) {
  const headerUserId = req.headers['x-user-id'] || req.get('x-user-id') || '';

  if (headerUserId && headerUserId !== 'null' && headerUserId !== 'undefined') {
    return headerUserId;
  }

  if (req.session && req.session.userId) {
    return req.session.userId;
  }

  const userId = req.headers['x-user-id'] || req.get('x-user-id') || '';

  // Filter out invalid values
  if (!userId || userId === 'null' || userId === 'undefined') {
    return null;
  }
  return userId;
}

// Extract Authorization Bearer token from request headers
function getRequestToken(req) {
  const authHeader = req.get('authorization') || req.headers['authorization'] || req.headers['Authorization'] || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = bearerMatch ? bearerMatch[1] : null;

  // Filter out invalid tokens
  if (token === 'null' || token === 'undefined' || !token) {
    return null;
  }
  return token;
}

// Middleware: restore per-user access token from Authorization header if not in memory.
// This allows switching between authenticated users without requiring re-authentication
// even after a server restart, as long as the client sends the stored Bearer token.
app.use((req, _res, next) => {
  const userId = getRequestUserId(req);
  const token = getRequestToken(req);
  if (userId && token && !getUserAccessToken(userId)) {
    setUserAccessToken(userId, token);
  }
  next();
});

// Health check
app.get('/api/health', async (_req, res) => {
  try {
    await get('SELECT 1 AS ok');
    res.json({ status: 'ok', db: 'connected' });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/api/settings/sell-sl-percent', (_req, res) => {
  res.json({ sellSlPercent: SELL_SL_PERCENT, min: 0.5, max: 2 });
});

app.put('/api/settings/sell-sl-percent', (req, res) => {
  const value = Number(req.body?.sellSlPercent);
  if (Number.isNaN(value) || value < 0.5 || value > 2) {
    return res.status(400).json({ error: 'sellSlPercent must be between 0.5 and 2' });
  }

  SELL_SL_PERCENT = Math.round(value * 100) / 100;
  return res.json({ sellSlPercent: SELL_SL_PERCENT });
});

app.post('/api/authenticate', async (req, res, next) => {
  try {
    const { secretkey } = req.body;
    const userId = req.body?.userId || getRequestUserId(req);

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    if (typeof secretkey !== 'string' || !secretkey.trim()) {
      return res.status(400).json({ error: 'secretkey (access token) is required' });
    }

    const isValid = await IsvalidToken(userId, secretkey.trim());
    if (!isValid || !isValid.status) {
      return res.status(401).json({ error: 'Invalid access token.' });
    }

    req.session.userId = isValid.user_id;
    req.session.authenticatedAt = Date.now();

    console.log(`Authentication successful for user ${isValid.user_id}`);
    res.json({ user: isValid.user_id, message: `${isValid.user_id} authenticated successfully.` });
  } catch (err) {
    next(err);
  }
});

// Returns the Kite OAuth login URL; frontend redirects the user to it
app.get('/api/kite-login-url', (req, res) => {
  const userId = req.query.userId || '';
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'KITE_API_KEY not configured in .env' });

  const params = new URLSearchParams({ api_key: apiKey, v: 3 });
  if (userId) params.set('state', userId);
  res.json({ url: `https://kite.zerodha.com/connect/login?${params}` });
});

// Kite redirects here after login with ?request_token=xxx&status=success
app.get('/api/kite-callback', async (req, res, next) => {
  try {
    const { request_token, status, state } = req.query;

    if (status !== 'success' || !request_token) {
      return res.status(400).send('Kite login failed or request_token missing.');
    }

    const apiKey    = process.env.KITE_API_KEY;
    const apiSecret = process.env.KITE_API_SECRET;

    if (!apiKey || !apiSecret) {
      return res.status(500).send('KITE_API_KEY or KITE_API_SECRET not configured in .env');
    }

    // Exchange request_token → access_token using SHA-256 checksum
    const { createHash } = await import('crypto');
    const checksum = createHash('sha256')
      .update(apiKey + request_token + apiSecret)
      .digest('hex');

    const tokenResp = await fetch('https://api.kite.trade/session/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' },
      body: new URLSearchParams({ api_key: apiKey, request_token, checksum }),
    });

    const tokenText = await tokenResp.text();
    //console.log(`[kite-callback] Token exchange status: ${tokenResp.status}, body: ${tokenText}`);

    if (!tokenResp.ok) {
      return res.status(tokenResp.status).send('Token exchange failed: ' + tokenText);
    }

    const tokenJson = JSON.parse(tokenText);
    const accessToken = tokenJson.data?.access_token;
    const kiteUserId  = tokenJson.data?.user_id || state;

    if (!accessToken || !kiteUserId) {
      return res.status(500).send('No access_token or user_id in Kite response.');
    }

    // Store token in memory for Sensibull operations
    setUserAccessToken(kiteUserId, accessToken);
    req.session.userId = kiteUserId;
    req.session.authenticatedAt = Date.now();
    //console.log(`[kite-callback] Authenticated user ${kiteUserId}, token length=${accessToken.length}`);

    // Redirect to app — frontend picks up user + token from URL params
    res.redirect(`/?user=${encodeURIComponent(kiteUserId)}&token=${encodeURIComponent(accessToken)}`);
  } catch (err) {
    next(err);
  }
});


app.get('/api/orders', async (req, res, next) => {
  try {
    // const userId = getRequestUserId(req);
    const userId = getRequestUserId(req) || 'UVP969'; // <-- use default_user if userId is missing for testing
    if (!userId) {
      return res.status(400).json({ error: 'X-User-Id header is required' });
    }
    const orders = await Ordersmap(userId);
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

// -------- Devices CRUD --------

// List all devices
app.get('/api/devices', async (_req, res, next) => {
  try {
    const rows = await all(`
      SELECT id, symbol, token, strike, quantity, stop_loss, allocated_to, allocated_at, expiry, created_at
      FROM devices
      ORDER BY id ASC
    `);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Sync devices from request body
app.post('/api/devices/sync', async (req, res, next) => {
  try {
    const { devices } = req.body;
    console.log('Received devices body type:', typeof devices, 'isArray:', Array.isArray(devices));
    if (!Array.isArray(devices)) {
      return res.status(400).json({ error: 'devices must be an array' });
    }

    const results = [];
    for (const device of devices) {
      const { underlying, symbol, token, strike, quantity, stop_loss } = device;

      if (typeof underlying !== 'string' || !underlying.trim()) {
        results.push({ error: 'underlying is required', device });
        continue;
      }
      if (typeof symbol !== 'string' || !symbol.trim()) {
        results.push({ error: 'symbol is required', device });
        continue;
      }
      if (!(typeof token !== 'string' || typeof token !== 'integer')) {
        results.push({ error: 'token is required', device });
        continue;
      }
      if (!(typeof strike !== 'string' || typeof strike !== 'integer')) {
        results.push({ error: 'strike is required', device });
        continue;
      }
      if (!(typeof quantity !== 'string' || typeof quantity !== 'integer')) {
        results.push({ error: 'quantity is required', device });
        continue;
      }
      if (!(typeof stop_loss !== 'string' || typeof stop_loss !== 'integer')) {
        results.push({ error: 'stop_loss is required', device });
        continue;
      }

      try {
        // Check if token exists
        const existing = await get(`SELECT id FROM devices WHERE token = ?`, [token]);

        let lastID;
        if (existing) {
          // Update existing record
          await run(
            `UPDATE devices SET underlying = ?, symbol = ?, strike = ?, quantity = ?, stop_loss = ? WHERE token = ?`,
            [underlying.trim(), symbol.trim(), strike, quantity, stop_loss, token]
          );
          lastID = existing.id;
        } else {
          // Insert new record
          const result = await run(
            `INSERT INTO devices (underlying, symbol, token, strike, quantity, stop_loss) VALUES (?, ?, ?, ?, ?, ?)`,
            [underlying.trim(), symbol.trim(), token, strike, quantity, stop_loss]
          );
          lastID = result.lastID;
        }
        const row = await get(`SELECT * FROM devices WHERE id = ?`, [lastID]);
        results.push({ success: true, data: row });
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) {
          results.push({ error: 'Token must be unique', device });
        } else {
          results.push({ error: e.message, device });
        }
      }
    }

    res.status(201).json({ results });
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
    if (isNaN(Number(quantity.trim()))) {
      return res.status(400).json({ error: 'quantity must be a valid number string' });
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
app.put('/api/devices/:id/chsl', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { stop_loss, symbol } = req.body;

    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });

    if (stop_loss === undefined) {
      return res.status(400).json({ error: 'stop_loss is required' });
    }

    if (typeof stop_loss !== 'string' || !stop_loss.trim()) {
      return res.status(400).json({ error: 'stop_loss must be a non-empty string' });
    }

    if (isNaN(Number(stop_loss.trim()))) {
      return res.status(400).json({ error: 'stop_loss must be a valid number string' });
    }

    // Fetch current portfolio to find the position
    const { portfolioData } = await portfolioDetails(userId);
    if (!portfolioData) {
      return res.status(404).json({ error: 'Portfolio not found' });
    }

    const transformedRows = transformPortfolioResponse(portfolioData);
    const combined = await enrichPortfolioWithInstruments(transformedRows);

    //console.log('combined:', combined);  // <-- debug log

    // Find the position matching the symbol
    const position = combined.find(p => p.symbol === symbol);
    if (!position) {
      return res.status(404).json({ error: 'Position not found in portfolio' });
    }

    // Update stop_loss in memory (portfolio position)
    position.stop_loss = Number(stop_loss.trim());

    //console.log('combined:', combined);  // <-- debug log

    // Update stop_loss in the database
    /*const { changes } = await run(
      `UPDATE devices SET stop_loss = ? WHERE id = ?`,
      [stop_loss.trim(), id]
    );

    if (changes === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }*/

    const row = await get(`SELECT * FROM devices WHERE id = ?`, [id]);
    res.json(row);

  } catch (err) {
    next(err);
  }
});

// -------- Allocation actions --------
// list portfolio
app.get('/api/portfolio', async (req, res, next) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'X-User-Id header is required' });
    }

    // If a Bearer token is present, store it as the access token for this user
    const acc_tok = getRequestToken(req);
    if (acc_tok) {
      setUserAccessToken(userId, acc_tok);
    }

    const { portfolioData } = await portfolioDetails(userId);
    if (!portfolioData) {
      return res.status(200).json([]);
    }
    const transformedRows = transformPortfolioResponse(portfolioData);
    const combined = await enrichPortfolioWithInstruments(transformedRows);
    res.json(combined);
  } catch (err) {
    next(err);
  }
});


// add more lots to the existing
app.post('/api/devices/:id/addmore', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const userId = getRequestUserId(req);
    const { symbol, lots, price, lot_size, type } = req.body;
    
    if (!userId) {
      return res.status(401).json({ error: 'X-User-Id header is required' });
    }
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });
    if (typeof lots !== 'string' || !lots.trim()) {
      return res.status(400).json({ error: 'lots is required' });
    }
    if (isNaN(Number(lots.trim()))) {
      return res.status(400).json({ error: 'lots must be a valid number string' });
    }
    const quant = Number(lots.trim()) * Number(lot_size);
    const ret = await createOrderPayload(userId, type, symbol, quant, price);

    if (!ret.status || ret.status === false) {
        return res.status(ret.code).json({ error: 'Failed to create order payload: '+JSON.stringify(ret), details: ret.error || ret.details });
    }

    const row = await get(`SELECT * FROM devices WHERE id = ?`, [id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Exit position (clear allocation)
app.post('/api/devices/:id/exit', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const userId = getRequestUserId(req);
    const { symbol, quantity, price, lot_size, type, ordertype } = req.body;
    
    if (!userId) {
      return res.status(401).json({ error: 'X-User-Id header is required' });
    }
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });

    const quant = Math.abs(Number(quantity))
    console.log('Request body:', JSON.stringify(req.body));
    const exitType = Number(quantity) < 0 ? "BUY" : "SELL";
    console.log('Inverted type for release:', exitType);
    const ret = await createOrderPayload(userId, exitType, symbol, quant, price, ordertype);

    if (!ret.status || ret.status === false) {
        return res.status(ret.code).json({ error: 'Failed to create order payload: '+JSON.stringify(ret), details: ret.error || ret.details });
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

// Auto-exit monitor for stop-loss
setInterval(async () => {
  try {
    // return; // <-- disable auto-exit for now
    // Iterate through all users and check their portfolios
    for (const [userId] of userAccessTokens.entries()) {
      // Refresh portfolio and pending orders in parallel. pendingOrdersmap() updates
      // pendingOrders to only OPEN statuses, which removes CANCELLED/REJECTED keys.
      const [{ portfolioData }] = await Promise.all([
        portfolioDetails(userId),
        Ordersmap(userId)
      ]);
      if (!portfolioData) continue;

      const transformedRows = transformPortfolioResponse(portfolioData);
      const combined = await enrichPortfolioWithInstruments(transformedRows);

      for (const position of combined) {
        if (position.quantity === 0) continue;

        // Check if current time in IST is greater than 10:20 AM
        const istTime = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }).format(new Date());
        const [h, m] = istTime.split(':').map(Number);
        const afterCutoff = (h * 60 + m) > (10 * 60 + 20) && (h * 60 + m) < (15 * 60 + 10); // after 10:20 AM and before 3:10 PM

        if (afterCutoff) {
          console.log('Running auto-exit monitor at', istTime);
        }

        const shouldExit = afterCutoff && (
          position.quantity < 0 
            ? position.ltp >= position.stop_loss 
            : position.ltp <= position.stop_loss
        );

        if (shouldExit) {
          const exitType = position.quantity < 0 ? "BUY" : "SELL";
          const exitQuantity = Math.abs(position.quantity);

          // Check if order is already pending
          if (hasPendingOrder(userId, position.symbol, exitType, exitQuantity)) {
            console.log(`Order already pending for ${position.symbol} (${exitType}, qty=${exitQuantity}), skipping...`);
            continue;
          }

          console.log(`Auto-exit triggered for ${position.symbol}: LTP=${position.ltp}, SL=${position.stop_loss} at time:${istTime}`);
          // console.log(`Position details:`, JSON.stringify(position)); // <-- debug log

          try {
            const ret = await createOrderPayload(userId, exitType, position.symbol, exitQuantity, position.ltp);

            if (ret && ret.status) {
              console.log(`Successfully auto-exited ${position.symbol}`);
              await getPendingOrders(userId); // refresh with upstream OPEN orders
            } else {
              console.error(`Failed to auto-exit ${position.symbol}:`, ret?.error);
            }
          } catch (placeErr) {
            console.error(`Auto-exit place order exception for ${position.symbol}:`, placeErr);
          }
        }
      }
    }
  } catch (err) {
    console.error('Auto-exit monitor error:', err);
  }
}, 5000); // Check every 5 seconds

// Function calls
async function createOrderPayload(userId, action, symbol, quantity, price, orderType = "LIMIT") {
  // Implementation here
  const trades = {"tradingsymbol":symbol,"exchange":"NFO","transaction_type":action,"order_type":orderType,
    "quantity":quantity,"price":price,"trigger_price":price,"product":"NRML","validity":"DAY"}
  let basket_info = await createBasket(userId, trades); // <-- ensure basket is created before placing orders
  
  const callbackUrl = `https://oxide.sensibull.com/v1/pluto/pbp/order/place/1/${basket_info.basket_order_id}`; // <-- real trading endpoint here 1 is a broker_id for zerodha.
  const accessToken = getUserAccessToken(userId);

  if (!accessToken) {
    return { status: false, error: 'No access token found for user', code: 401 };
  }
  
  const payload = {
    basket_id: basket_info.basket_order_id,
    orders: [
    {
      basket_order_entry_id: basket_info.basket_order_entry.basket_order_entry_id,
      market_protection: true,
      order_type: orderType,
      price: Number(price),
      product: "NRML",
      quantity: Number(quantity),
      transaction_type: action,
      trigger_price: orderType === "SL" ? Number(price) : 0,
      validity: "DAY" }
    ],
    place_mode: "PLACE_INDIVIDUAL_ORDER"
  };
  // console.log('Placing order with payload:', JSON.stringify(payload)); // <-- debug log

    try {
      const resp = await fetch(callbackUrl, {
        method: 'POST',
        headers: sensibullHeaders(accessToken, userId),
        body: JSON.stringify(payload),
      });
      ////////////////////// Debugging info //////////////////////
      const cloned = resp.clone();
      const respText = await cloned.text().catch(() => '<unreadable>');
      /* console.log(' createOrder Upstream response:', {
        status: resp.status,
        statusText: resp.statusText,
        headers: Object.fromEntries(resp.headers.entries ? resp.headers.entries() : []),
        body: respText
      }); */
      ////////////////////////////////////////////////////////////
      if (!resp.ok) {
        const text = await resp.text().catch(() => '<unreadable>');
        return { status: false, error: respText, code: resp.status };
      }
      const respJson = await resp.json().catch(() => null);
      //console.log(JSON.stringify({ status: true, response: respJson }));
      return { status: true, response: respJson };
    } catch (e) {
      console.log(JSON.stringify({ error: 'Failed to contact upstream service', message: e.message }));
      return { status: false, error: e.message };
    }
}

async function createBasket(userId, trades) {
  // Implementation here
    const Url = 'https://oxide.sensibull.com/v1/pluto/pbp/init_and_fetch/1';
    const accessToken = getUserAccessToken(userId);

    const payload = {
      "device":"WEB_DESKTOP",
      "feature":"SB_POSITIONS",
      "trades": [trades],
      "is_quick_trade":true,
    }

    try {
      const resp = await fetch(Url, {
        method: 'POST',
        headers: sensibullHeaders(accessToken, userId),
        body: JSON.stringify(payload),
      });
      const cloned = resp.clone();
      const respText = await cloned.text().catch(() => '<unreadable>');
      const respJson = JSON.parse(respText);
      /*////////////////////// Debugging info //////////////////////
      console.log('createBasket Upstream response:', {
        status: resp.status,
        statusText: resp.statusText,
        headers: Object.fromEntries(resp.headers.entries ? resp.headers.entries() : []),
        body: respText
      });
      ////////////////////////////////////////////////////////////*/
      if (!resp.ok) {
        const text = await resp.text().catch(() => '<unreadable>');
        console.log(JSON.stringify({ error: resp.statusText, details: text }));
        return [];
      }
      return { basket_order_id: respJson.payload.basket_order.basket_order_id, basket_order_entry: respJson.payload.basket_page_data.basket_order_entries[0].basket_order_entries[0]} || [] ;
    } catch (e) {
      console.log(JSON.stringify({ error: 'Failed to contact upstream service', message: e.message }));
      return [];
    }

}

async function Ordersmap(userId) {
  // Implementation here
  const accessToken = getUserAccessToken(userId);
  const Url = 'https://oxide.sensibull.com/v1/compute/1/broker_data/user_orders?fno=true&equities=false&holdings=false'; // <-- real trading endpoint
  if (!accessToken) {
    console.log(`No access token found for user ${userId}`);
    return { orders: [] };
  }

  try {
    const resp = await fetch(Url, {
      method: 'GET',
      headers: sensibullHeaders(accessToken, userId),
    });
    ////////////////////// Debugging info //////////////////////
    const cloned = resp.clone();
    const respText = await cloned.text().catch(() => '<unreadable>');
    const respJson = JSON.parse(respText);
    /* console.log('pendingOrders Upstream response:', {
      status: resp.status,
      statusText: resp.statusText,
      headers: Object.fromEntries(resp.headers.entries ? resp.headers.entries() : []),
      body: respText,
      data: JSON.stringify(respJson || {}),
    }); */
    ////////////////////////////////////////////////////////////
    if (!resp.ok) {
      const text = await resp.text().catch(() => '<unreadable>');
      console.log(JSON.stringify({ error: resp.statusText, details: text }));
      return { orders: [] };
    }
    const orders = respJson.payload.orders || [];
    syncPendingOrders(userId, orders);
    
    return { orders };
  } catch (e) {
    console.log(JSON.stringify({ error: 'Failed to contact upstream service', message: e.message }));
    return { orders: [] };
  }
}

async function portfolioDetails(userId) {
  // Implementation here
  const accessToken = getUserAccessToken(userId);
  const Url = 'https://oxide.sensibull.com/v1/compute/1/broker_data/user_positions_v2?fno=true&equities=false&holdings=false'; // <-- real trading endpoint
  
  if (!accessToken) {
    console.log(`No access token found for user ${userId}`);
    return { portfolioData: null };
  }

    try {
      const resp = await fetch(Url, {
        method: 'GET',
        headers: sensibullHeaders(accessToken, userId),
      });
      const respText = await resp.text().catch(() => '{}');
      //console.log(`[portfolioDetails] status=${resp.status} body=${respText.slice(0, 200)}`);
      if (!resp.ok) {
        console.log(JSON.stringify({ error: resp.statusText, details: respText }));
        return { portfolioData: null };
      }
      let respJson;
      try { respJson = JSON.parse(respText); } catch { return { portfolioData: null }; }
      const portfolioData = respJson.data || {};
      return { portfolioData };
    } catch (e) {
      console.log(JSON.stringify({ error: 'Failed to contact upstream service', message: e.message }));
      return { portfolioData: null };
    }
}

function transformPortfolioResponse(apiResponse) {
  const positions = apiResponse || [];
  /*Object.values(apiResponse).forEach((underlyingData) => {
    const underlying = underlyingData.product;
    const positionsList = [ underlyingData ] || [];
    positionsList.forEach((pos) => {
      positions.push({ ...pos, underlying });
    });
  });*/
  //console.log('positions:', JSON.stringify(positions)); // <-- debug log

  return positions.map((pos, index) => {
    const quantity = Number(pos.quantity) || 0;
    const avgPrice = Number(pos.average_price) || 0;
    const unbookedPnl = Number(pos.unbooked_profit_loss) || 0;
    const Ltp = Number(pos.last_price) || 0;

    // Sensibull can return last_price as 0 for some positions; derive LTP from PnL when possible.
    const derivedLtp = quantity !== 0 ? avgPrice + (unbookedPnl / quantity) : 0;
    const ltp = Ltp > 0 ? Ltp : (derivedLtp > 0 ? Math.round(derivedLtp * 100) / 100 : 0);

    return {
      id: index + 1,
      underlying: pos.underlying,
      symbol: pos.trading_symbol,
      quantity,
      avg_price: avgPrice,
      ltp,
      booked: Math.round(Number(pos.booked_profit_loss) || 0),
      unbooked: Math.round(unbookedPnl),
      total: Math.round(Number(pos.total_pnl) || 0),
      stop_loss: quantity < 0 ? Math.round(avgPrice * SELL_SL_PERCENT * 20) / 20 : Math.round(avgPrice * BUY_SL_PERCENT * 20) / 20
    };
  });
}

async function enrichPortfolioWithInstruments(portfolio) {
  // Merge portfolio with instrument info
  return Promise.all(portfolio.map(async (pos) => {
    const instInfo = await getInstrumentInfo(pos.symbol) || {};
    return {
      ...pos,
      expiry: instInfo.expiry || null,
      strike: instInfo.strike || pos.strike,
      token: instInfo.instrument_token || null,
      type: instInfo.instrument_type || null,
      lot_size: instInfo.lot_size || null,
      is_expired: instInfo.is_expired || false
    };
  }));
}

async function presentStrategy(userId, stratergy_name="SHORT_STRADDLE", expiry_date="2025-12-16", underlying_token=256265) {
  // Implementation here
  const Url = 'https://oxide.sensibull.com/v1/compute/1/presets';
  const accessToken = getUserAccessToken(userId);
  
  if (!accessToken) {
    return { status: false, error: 'No access token found for user', code: 401 };
  }
  
  const payload =  {
      expiry: expiry_date,
      strategy_type: stratergy_name,
      underlying_token: underlying_token
    };

    try {
      const resp = await fetch(Url, {
        method: 'POST',
        headers: sensibullHeaders(accessToken, userId),
        body: JSON.stringify(payload),
      });
      ////////////////////// Debugging info //////////////////////
      const cloned = resp.clone();
      const respText = await cloned.text().catch(() => '<unreadable>');
      console.log('presentStrategy Upstream response:', {
        status: resp.status,
        statusText: resp.statusText,
        headers: Object.fromEntries(resp.headers.entries ? resp.headers.entries() : []),
        body: respText
      });
      ////////////////////////////////////////////////////////////
      if (!resp.ok) {
        const text = await resp.text().catch(() => '<unreadable>');
        return { status: false, error: respText, code: resp.status };
      }
      const respJson = await resp.json().catch(() => null);
      //console.log(JSON.stringify({ status: true, response: respJson }));
      return { status: true, response: respJson };
    } catch (e) {
      console.log(JSON.stringify({ error: 'Failed to contact upstream service', message: e.message }));
      return { status: false, error: e.message };
    }
}

async function IsvalidToken(userId, token) {
  const accessToken = (token || '').trim();
  if (!accessToken) {
    console.log(`[IsvalidToken] No token provided for user ${userId}`);
    return false;
  }
  // Store token immediately — Sensibull upstream calls will confirm validity
  const resolvedUserId = userId || 'unknown';
  setUserAccessToken(resolvedUserId, accessToken);
  console.log(`[IsvalidToken] Token stored for user ${resolvedUserId}, length=${accessToken.length}`);
  return { status: true, user_id: resolvedUserId };
}

async function downloadInstrumentsCSV() {
  const instrumentsUrl1 = 'https://api.kite.trade/instruments/BFO';
  const instrumentsUrl2 = 'https://api.kite.trade/instruments/NFO';

  // Ensure fs is always available in this scope
  const fs = (await import('fs')).default || await import('fs');
  const csv = (await import('csv-parser')).default || await import('csv-parser');
  fs.writeFileSync('instruments.csv', ''); // Clear existing file before appending new data

  for (const url of [instrumentsUrl1, instrumentsUrl2]) {
    try {
      const resp = await fetch(url);
      const text = await resp.text();
      fs.appendFileSync('instruments.csv', text);
    }
    catch (err) {
      console.error(`Failed to fetch from ${url}:`, err);
    }
  }
}

async function getInstrumentInfo(tradingsymbols) {
  try {
    // Check if data is already cached
    if (instrumentsMap[tradingsymbols]) {
      return instrumentsMap[tradingsymbols];
    }

    // Only load CSV if we haven't already loaded all data
    if (Object.keys(instrumentsMap).length === 0) {
      const fsModule = await import('fs');
      const fsInstance = fsModule.default || fsModule;
      const csv = (await import('csv-parser')).default || await import('csv-parser');
      
      await new Promise((resolve, reject) => {
        fsInstance.createReadStream('instruments.csv')
          .pipe(csv())
          .on('data', (row) => {
            instrumentsMap[row.tradingsymbol] = {
              instrument_token: parseInt(row.instrument_token),
              exchange_token: parseInt(row.exchange_token),
              symbol: row.tradingsymbol,
              underlying_symbol: row.name,
              last_price: parseFloat(row.last_price),
              expiry: row.expiry || '',
              strike: parseFloat(row.strike) || 0,
              tick_size: parseFloat(row.tick_size) || 0,
              lot_size: parseInt(row.lot_size),
              instrument_type: row.instrument_type === 'CE' ? 'Call' : row.instrument_type === 'PE' ? 'Put' : row.instrument_type
            };
          })
          .on('end', () => resolve())
          .on('error', reject);
      });
    }
    return instrumentsMap[tradingsymbols] || {};
  } catch (err) {
    console.error(`Failed to fetch from instruments.csv:`, err);
    return {};
  }
}

      

// Global error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

// Start server
const httpsPort = Number(process.env.HTTPS_PORT || 3443);
const httpPort  = Number(process.env.PORT || 3050);

// HTTPS server
const sslOptions = {
  key:  fs.readFileSync(new URL('../key.pem',  import.meta.url)),
  cert: fs.readFileSync(new URL('../cert.pem', import.meta.url)),
};
const { networkInterfaces } = await import('os');
const _hostIp = Object.values(networkInterfaces()).flat().find(a => a.family === 'IPv4' && !a.internal)?.address || 'localhost';

https.createServer(sslOptions, app).listen(httpsPort, () => {
  console.log(`Device Inventory listening on https://${_hostIp}:${httpsPort}`);
});

// HTTP server — redirects all traffic to HTTPS
http.createServer((req, res) => {
  const host = (req.headers.host || `localhost:${httpsPort}`).replace(/:\d+$/, '');
  res.writeHead(301, { Location: `https://${host}:${httpsPort}${req.url}` });
  res.end();
}).listen(httpPort, () => {
  console.log(`HTTP on port ${httpPort} → redirecting to https://${_hostIp}:${httpsPort}`);
});
