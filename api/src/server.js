import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { init, all, get, run } from './db.js';
import OTPLib from 'otplib';
import { runInThisContext } from 'vm';

const app = express();
app.use(morgan('dev'));
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
//app.use(express.static(path.join(__dirname, '../../public')));

const publicDir = path.resolve(__dirname, '../public');
// Dynamic public directory resolution
let publicDirResolved = publicDir;
const fs = await import('fs');
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

// Per-user state storage (Maps indexed by userId/username)
const userPortfolios = new Map();           // userId -> portfolioId
const userPaperTradeGroups = new Map();     // userId -> paperTradeGroupId
const userAccessTokens = new Map();         // userId -> accessToken
const pendingOrders = new Map();            // userId -> Set of pending order keys (symbol_action)
const instrumentsMap = {};                  // tradingsymbol -> instrument info


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
    pendingOrders.delete(userId);
    console.log(`Cleared all data for user ${userId}`);
  }
}

// Helper functions for managing pending orders
function setPendingOrder(userId, symbol, action) {
  if (userId && symbol && action) {
    const orderKey = `${symbol}_${action}`;
    if (!pendingOrders.has(userId)) {
      pendingOrders.set(userId, new Set());
    }
    pendingOrders.get(userId).add(orderKey);
    console.log(`Pending order added for user ${userId}: ${orderKey}`);
  }
}

function removePendingOrder(userId, symbol, action) {
  if (userId && symbol && action) {
    const orderKey = `${symbol}_${action}`;
    if (pendingOrders.has(userId)) {
      pendingOrders.get(userId).delete(orderKey);
      console.log(`Pending order removed for user ${userId}: ${orderKey}`);
    }
  }
}

function getPendingOrders(userId) {
  return userId && pendingOrders.has(userId) ? pendingOrders.get(userId) : new Set();
}

function hasPendingOrder(userId, symbol, action) {
  if (!userId || !symbol || !action) return false;
  const orderKey = `${symbol}_${action}`;
  return pendingOrders.has(userId) && pendingOrders.get(userId).has(orderKey);
}

// Extract userId from request header (X-User-Id)
function getRequestUserId(req) {
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

// Health check
app.get('/api/health', async (_req, res) => {
  try {
    await get('SELECT 1 AS ok');
    res.json({ status: 'ok', db: 'connected' });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/api/authenticate', async (req, res, next) => {
  try {
    const { secretkey } = req.body;
    const userId = getRequestUserId(req);

    if (!userId) {
      return res.status(400).json({ error: 'X-User-Id header is required' });
    }
    if (typeof secretkey !== 'string' || !secretkey.trim()) {
      return res.status(400).json({ error: 'secretkey is required' });
    }
    const code = OTPLib.authenticator.generate(secretkey.trim());
    //console.log('Generated OTP code:', code); // <-- debug log

    // Example usage with Sensibull API key (replace with actual logic as needed)
    const url = 'https://kite.zerodha.com/connect/login';
    const sensibullApiKey = 'uf8cguv719djhxfc';
    const params = {
      api_key: sensibullApiKey,
      v: 3,
      redirect_params: 'redirect_url=https://web.sensibull.com/home'
    };

    const resp = await fetch(url + '?' + new URLSearchParams(params), {
      method: 'GET',
    });
    ////////////////////// Debugging info //////////////////////
    /*console.log('Sensibull API response:', {
      status: resp.status,
      statusText: resp.statusText,
      headers: Object.fromEntries(resp.headers.entries ? resp.headers.entries() : []),
      cookies: resp.headers.get('set-cookie') || 'none',
      //body: await resp.text().catch(() => '<unreadable>')
    });*/
    ////////////////////////////////////////////////////////////

    if (!resp) {
      return res.status(500).json({ error: 'Failed to contact Sensibull API' });
    }
    else if (!resp.ok) {
      const text = await resp.text().catch(() => '<unreadable>');
      return res.status(resp.status).json({ error: 'Sensibull API error', details: text });
    } 

    const isValid = await IsvalidToken(userId, secretkey.trim()); // <-- test call to upstream to validate token
    //console.log('Access token validation result:', isValid); // <-- debug log
    if (!isValid.status) {
      return res.status(401).json({ error: 'Invalid access token.' });
    }
    console.log(`Authentication successful for user ${isValid.user_id}`);
    res.json({ 'code': code, 'user': isValid.user_id, 'message': `${isValid.user_id} authentication successful. Access token is set.` });
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
    await downloadInstrumentsCSV(); // <-- download instrument info CSV
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'X-User-Id header is required' });
    }

  }catch (err) {
    next(err);
  }

  // fetch portfolio details after ensuring portfolioId is set
  try {
    const userId = getRequestUserId(req);
    var portfolioId = Buffer.from(`${userId}:${portfolioId}`).toString('base64');
    setUserPortfolio(userId, portfolioId);
    const { portfolioData } = await portfolioDetails(userId);
    if (!portfolioData) {
      return res.status(304).json({ error: 'No portfolio data.. Please select the portfolio' });
    }
    // console.log('portfolioData:', JSON.stringify(portfolioData)); // <-- debug log
    // console.log('instrumentData:', JSON.stringify(instrumentData)); // <-- debug log
    const transformedRows = transformPortfolioResponse(portfolioData);
    const combined = await enrichPortfolioWithInstruments(transformedRows);
    // console.log('combined:', JSON.stringify(combined)); // <-- debug log
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
    return; // <-- disable auto-exit for now
    // Iterate through all users and check their portfolios
    for (const [userId, portfolioId] of userPortfolios.entries()) {
      const { portfolioData } = await portfolioDetails(userId);
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

        const shouldExit = afterCutoff && (
          position.quantity < 0 
            ? position.ltp >= position.stop_loss 
            : position.ltp <= position.stop_loss
        );

        if (shouldExit) {
          const exitType = position.quantity < 0 ? "BUY" : "SELL";
          const orderKey = `${position.symbol}_${exitType}`;

          // Check if order is already pending
          if (hasPendingOrder(userId, position.symbol, exitType)) {
            console.log(`Order already pending for ${position.symbol} (${exitType}), skipping...`);
            continue;
          }

          console.log(`Auto-exit triggered for ${position.symbol}: LTP=${position.ltp}, SL=${position.stop_loss} at time:${istTime}`);
          // console.log(`Position details:`, JSON.stringify(position)); // <-- debug log

          const exitQuantity = Math.abs(position.quantity);

          const ret = await createOrderPayload(userId, exitType, position.symbol, exitQuantity, position.ltp);

          if (ret.status) {
            console.log(`Successfully auto-exited ${position.symbol}`);
            setPendingOrder(userId, position.symbol, exitType);
          } else {
            console.error(`Failed to auto-exit ${position.symbol}:`, ret.error);
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
        headers: { 'Content-Type': 'application/json', 'Cookie': 'access_token=' + accessToken },
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
      return console.log(JSON.stringify({ error: 'Failed to contact upstream service', message: e.message }));
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
        headers: { 'Content-Type': 'application/json', 'Cookie': 'access_token=' + accessToken },
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
      return console.log(JSON.stringify({ error: 'Failed to contact upstream service', message: e.message }));
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
        headers: { 'Content-Type': 'application/json', 'Cookie': 'access_token=' + accessToken },
      });
      ////////////////////// Debugging info //////////////////////
      const cloned = resp.clone();
      const respText = await cloned.text().catch(() => '<unreadable>');
      const respJson = JSON.parse(respText);
      /* console.log('portfolioDetails Upstream response:', {
        status: resp.status,
        statusText: resp.statusText,
        headers: Object.fromEntries(resp.headers.entries ? resp.headers.entries() : []),
        body: respText,
        data: JSON.stringify(respJson || {}),
      }); */
      ////////////////////////////////////////////////////////////
      if (!resp.ok) {
        const text = await resp.text().catch(() => '<unreadable>');
        return console.log(JSON.stringify({ error: resp.statusText, details: text }));
      }
      const portfolioData = respJson.data || {};
      //const instrumentData = respJson.payload.instrument_info || {};
      //const orderBookGroups = respJson.payload.groups[0].orders || {};
      //const paperTradeGroupId = respJson.payload.groups[0].id || '';
      
      // Store paper trade group for this user
      /*if (paperTradeGroupId) {
        setUserPaperTradeGroup(userId, paperTradeGroupId);
      }*/

      return { portfolioData };
    } catch (e) {
      return console.log(JSON.stringify({ error: 'Failed to contact upstream service', message: e.message }));
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
      stop_loss: quantity < 0 ? Math.round(avgPrice * 1.5 * 20) / 20 : Math.round(avgPrice * 0.33 * 20) / 20
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
        headers: { 'Content-Type': 'application/json', 'Cookie': 'access_token=' + accessToken },
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
      return console.log(JSON.stringify({ error: 'Failed to contact upstream service', message: e.message }));
    }
}

async function IsvalidToken(userId, token) {
  //const Url = 'https://oxide.sensibull.com/v1/compute/1/broker_data/user_ato';
  const Url = 'https://api.sensibull.com/v1/users/me?source=platform';
  const accessToken = token ? token : getUserAccessToken(userId);
  
  if (!accessToken) {
    console.log(`No access token found for user ${userId}`);
    return false;
  }
  
  try {
    const resp = await fetch(Url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'Cookie': 'access_token=' + accessToken },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '<unreadable>');
      console.log(JSON.stringify({ error: resp.statusText, details: text }));
      return false;
    }
    const respJson = await resp.json().catch(() => null);
    if (respJson && respJson.data && respJson.data.external_user_id) {
      const externalUserId = respJson.data.external_user_id;
      //return json.externalUserId === userId;
      setUserAccessToken(externalUserId, token.trim()); // Store token for this user
      return { status: true, user_id: externalUserId };
    }
    
    return false; // If response structure is unexpected, treat as invalid

  } catch (e) {
    console.log(JSON.stringify({ error: 'Failed to contact upstream service', message: e.message }));
    return false;
  }
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
const port = Number(3050);
app.listen(port, () => {
  console.log(`Device Inventory listening on http://localhost:${port}`);
});
