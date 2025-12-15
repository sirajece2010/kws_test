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

const publicDir = path.resolve(__dirname, '../../public');
console.log('Serving static from:', publicDir); // <-- add this for debug
app.use(express.static(publicDir))

await init();

// Global vairables
globalThis.portfolioId = '';
globalThis.paperTradeGroupId = '';
globalThis.accessToken = 'Qtxouimz4emrOtxm9jia4bwidnBvqU8cQHcf7_Gxxok'

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
    if (typeof secretkey !== 'string' || !secretkey.trim()) {
      return res.status(400).json({ error: 'secretkey is required' });
    }
    const code = OTPLib.authenticator.generate(secretkey.trim());
    console.log('Generated OTP code:', code); // <-- debug log

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
    console.log('Sensibull API response:', {
      status: resp.status,
      statusText: resp.statusText,
      headers: Object.fromEntries(resp.headers.entries ? resp.headers.entries() : []),
      cookies: resp.headers.get('set-cookie') || 'none',
      //body: await resp.text().catch(() => '<unreadable>')
    });
    ////////////////////////////////////////////////////////////

    if (!resp) {
      return res.status(500).json({ error: 'Failed to contact Sensibull API' });
    }

    res.json({ code });
  } catch (err) {
    next(err);
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

app.post('/api/getPortfolioId', async (req, res, next) => {
  try {
    portfolioList().then((data) => {
      res.json(data);
    });

  } catch (err) {
    next(err);
  }
});

app.post('/api/setPortfolioId', async (req, res, next) => {
  try {
    const { portfolioId } = req.body;
    if (typeof portfolioId !== 'string' || !portfolioId.trim()) {
      return res.status(400).json({ error: 'portfolioId is required' });
    }
    globalThis.portfolioId = portfolioId.trim();
    res.json({ status: 'Success', portfolioId: globalThis.portfolioId });
  } catch (err) {
    next(err);
  }
});

// -------- Allocation actions --------
// list portfolio
app.get('/api/portfolio', async (_req, res, next) => {
  try {
    // Ensure a portfolioId is selected. If not, fetch the portfolio list and pick the first one.
    if (!globalThis.portfolioId) {
      const portfolios = await portfolioList();
      if (!Array.isArray(portfolios) || portfolios.length === 0) {
      return res.status(404).json({ error: 'No portfolios found. Please select a portfolio' });
      }
      const first = portfolios[0];
      const pid = first.portfolio_id || first.id || first.portfolioId || first.uuid || first.key;
      if (!pid) {
      return res.status(500).json({ error: 'Unable to determine portfolio id from upstream' });
      }
      globalThis.portfolioId = String(pid);
    }
  }catch (err) {
    next(err);
  }

  // fetch portfolio details after ensuring portfolioId is set
  try {
    const { portfolioData, instrumentData } = await portfolioDetails();
    if (!portfolioData || !instrumentData) {
      return res.status(304).json({ error: 'No portfolio data.. Please select the portfolio' });
    }
    // console.log('portfolioData:', JSON.stringify(portfolioData)); // <-- debug log
    // console.log('instrumentData:', JSON.stringify(instrumentData)); // <-- debug log
    const transformedRows = transformPortfolioResponse(portfolioData);
    const instrumentInfo = transformInstrumentInfo(instrumentData);
    const combined = enrichPortfolioWithInstruments(transformedRows, instrumentInfo);
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
    const { symbol, lots, price, lot_size, type } = req.body;

    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });
    if (typeof lots !== 'string' || !lots.trim()) {
      return res.status(400).json({ error: 'lots is required' });
    }
    if (isNaN(Number(lots.trim()))) {
      return res.status(400).json({ error: 'lots must be a valid number string' });
    }
    const quant = Number(lots.trim()) * Number(lot_size);
    const ret = await createOrderPayload(type, symbol, quant, price);

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
    const { symbol, quantity, price, lot_size, type } = req.body;
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });

    const quant = Math.abs(Number(quantity))
    console.log('Request body:', JSON.stringify(req.body));
    const newtype = type === "SELL" ? "BUY" : "SELL";
    console.log('Inverted type for release:', newtype);
    const ret = await createOrderPayload(newtype, symbol, quant, price);

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

// Sample function to validate device fields
function validateDeviceFields(symbol, token, strike, quantity) {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    return { valid: false, error: 'symbol is required' };
  }
  if (typeof token !== 'string' || !token.trim()) {
    return { valid: false, error: 'token is required' };
  }
  if (typeof strike !== 'string' || !strike.trim()) {
    return { valid: false, error: 'strike is required' };
  }
  if (typeof quantity !== 'string' || !quantity.trim()) {
    return { valid: false, error: 'quantity is required' };
  }
  if (isNaN(Number(quantity.trim()))) {
    return { valid: false, error: 'quantity must be a valid number' };
  }
  return { valid: true };
}

// Function calls
async function createOrderPayload(action, symbol, quantity, price) {
  // Implementation here
  const callbackUrl = 'https://oxide.sensibull.com/v1/compute/vt2/order'; // <-- paper trading endpoint
  const payload = {
    orders: [
    {
      action: action,
      lot_size: (Number(quantity)),
      origin: "PAPER_NEW",
      price: (Number(price)),
      product_type: "NRML",
      quantity: action === "SELL" ? -(Number(quantity)) : (Number(quantity)),
      tradingsymbol: symbol,
      timestamp: new Date().toISOString()
    }
    ],
    paper_trade_group_id: paperTradeGroupId
  };

    try {
      const resp = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': 'access_token=' + accessToken },
        body: JSON.stringify(payload),
      });
      ////////////////////// Debugging info //////////////////////
      const cloned = resp.clone();
      const respText = await cloned.text().catch(() => '<unreadable>');
      /*console.log('Upstream response:', {
        status: resp.status,
        statusText: resp.statusText,
        headers: Object.fromEntries(resp.headers.entries ? resp.headers.entries() : []),
        body: respText
      });*/
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

async function portfolioList() {
  // Implementation here
  const Url = 'https://oxide.sensibull.com/v1/compute/vt2/portfolio_list/'; // <-- paper trading endpoint
  const payload = {
    "is_initial_load":false,
    "page_index":0,
    "page_size":20,
    "sort_field":"updatedat"
  };
    try {
      const resp = await fetch(Url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': 'access_token=' + accessToken },
        body: JSON.stringify(payload),
      });
      ////////////////////// Debugging info //////////////////////
      /*const cloned = resp.clone();
      const respText = await cloned.text().catch(() => '<unreadable>');
      console.log('Upstream response:', {
        status: resp.status,
        statusText: resp.statusText,
        headers: Object.fromEntries(resp.headers.entries ? resp.headers.entries() : []),
        body: respText
      });*/
      ////////////////////////////////////////////////////////////
      if (!resp.ok) {
        const text = await resp.text().catch(() => '<unreadable>');
        return console.log(JSON.stringify({ error: resp.statusText, details: text }));
      }
      const respJson = await resp.json().catch(() => null);
      return respJson.payload.portfolios || [];
    } catch (e) {
      return console.log(JSON.stringify({ error: 'Failed to contact upstream service', message: e.message }));
    }
}

async function portfolioDetails() {
  // Implementation here
  const Url = 'https://oxide.sensibull.com/v1/compute/vt2/portfolio_details/' + portfolioId; // <-- paper trading endpoint
  const payload = {
    "is_initial_load":true,
    "expanded_groups":[],
    "hide_closed_positions":false,
    "unchecked_groups":[],
    "unchecked_positions_per_group":{},
    "order_book_groups":[]
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
      const respJson = JSON.parse(respText);
      const groups = respJson.payload.groups[0] || {};
      //const symbolInfo = Object.values(groups.positions_per_underlying[0].positions || {}).find(pos => pos.tradingsymbol === symbol);
      /*console.log('Upstream response:', {
        status: resp.status,
        statusText: resp.statusText,
        headers: Object.fromEntries(resp.headers.entries ? resp.headers.entries() : []),
        body: respText,
        position: JSON.stringify(groups.positions_per_underlying || {}  ),
        Instru_info: JSON.stringify(respJson.payload.instrument_info || {})
      });*/
      ////////////////////////////////////////////////////////////
      if (!resp.ok) {
        const text = await resp.text().catch(() => '<unreadable>');
        return console.log(JSON.stringify({ error: resp.statusText, details: text }));
      }
      const portfolioData = respJson.payload.groups[0].positions_per_underlying || {};
      const instrumentData = respJson.payload.instrument_info || {};
      globalThis.paperTradeGroupId = respJson.payload.groups[0].id || '';

      return { portfolioData, instrumentData };
    } catch (e) {
      return console.log(JSON.stringify({ error: 'Failed to contact upstream service', message: e.message }));
    }
}

function transformPortfolioResponse(apiResponse) {
  const positions = [];
  Object.values(apiResponse).forEach((underlyingData) => {
    const underlying = underlyingData.underlying;
    const positionsList = underlyingData.positions || [];
    positionsList.forEach((pos) => {
      positions.push({ ...pos, underlying });
    });
  });
  //console.log('positions:', JSON.stringify(positions)); // <-- debug log

  return positions.map((pos, index) => ({
    id: index + 1,
    underlying: pos.underlying,
    symbol: pos.tradingsymbol,
    quantity: pos.open_qty,
    avg_price: pos.avg_price,
    ltp: pos.ltp,
    booked: Math.round(pos.realised_pnl),
    unbooked: Math.round(pos.unrealised_pnl),
    stop_loss: pos.open_qty < 0 ? Math.round(pos.avg_price * 1.5 * 20) / 20 : Math.round(pos.avg_price * 0.5 * 20) / 20
  }));
}

function transformInstrumentInfo(apiResponse) {
  return Object.values(apiResponse).map(inst => ({
    symbol: inst.tradingsymbol,
    expiry: inst.expiry,
    strike: inst.strike,
    token: inst.instrument_token,
    ltp: inst.ltp,
    inst_type: inst.instrument_type,
    lot_size: inst.lot_size
  }));
}

function enrichPortfolioWithInstruments(portfolio, instrumentInfo) {
  // Convert instrumentInfo array to a map keyed by symbol for O(1) lookup
  const instInfoMap = {};
  instrumentInfo.forEach(inst => {
    instInfoMap[inst.symbol] = inst;
  });

  // Merge portfolio with instrument info
  return portfolio.map(pos => {
    const instInfo = instInfoMap[pos.symbol] || {};
    return {
      ...pos,
      expiry: instInfo.expiry || null,
      strike: instInfo.strike || pos.strike,
      token: instInfo.token || null,
      type: instInfo.inst_type || null,
      lot_size: instInfo.lot_size || null,
      is_expired: instInfo.is_expired || false
    };
  });
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
