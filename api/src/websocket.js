import WebSocket from 'ws';

const DEFAULT_KITE_WS_URL = 'wss://ws.kite.trade';

export function normalizeToken(token) {
  const n = Number(token);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseTicks(bufferLike) {
  const data = Buffer.isBuffer(bufferLike) ? bufferLike : Buffer.from(bufferLike);
  if (!data || data.length < 2) return [];

  const packetCount = data.readUInt16BE(0);
  let offset = 2;
  const ticks = [];

  for (let i = 0; i < packetCount; i += 1) {
    if (offset + 2 > data.length) break;
    const packetLength = data.readUInt16BE(offset);
    offset += 2;

    if (offset + packetLength > data.length) break;
    const packet = data.subarray(offset, offset + packetLength);
    offset += packetLength;

    // LTP packet format: 4-byte instrument token + 4-byte last price (paise)
    if (packetLength === 8) {
      const instrument_token = packet.readUInt32BE(0);
      const last_price = packet.readUInt32BE(4) / 100;
      ticks.push({ instrument_token, last_price });
      continue;
    }

    // Quote packet format (44 bytes and above): first 4 bytes token, next 4 bytes last_price
    if (packetLength >= 12) {
      const instrument_token = packet.readUInt32BE(0);
      const last_price = packet.readUInt32BE(4) / 100;
      ticks.push({ instrument_token, last_price });
    }
  }

  return ticks;
}

function sendTickerMessage(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function getErrorMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function createWebsocketManager({ getAccessToken, apiKey, wsUrl = DEFAULT_KITE_WS_URL }) {
  const userTickers = new Map(); // userId -> websocket state
  const userLtpCache = new Map(); // userId -> Map(token -> ltp)
  const ltpWaiters = new Map(); // userId -> Set(resolve)

  function resolveLtpWaiters(userId) {
    const waiters = ltpWaiters.get(userId);
    if (!waiters || waiters.size === 0) return;

    const ltpMap = userLtpCache.get(userId);
    for (const resolve of waiters) {
      resolve(ltpMap);
    }
    ltpWaiters.delete(userId);
  }

  function subscribeTokens(userId, tokens = []) {
    const state = userTickers.get(userId);
    if (!state) return;

    const normalized = [...new Set(tokens.map(normalizeToken).filter(Boolean))];
    for (const token of normalized) {
      state.pendingTokens.add(token);
    }

    if (!normalized.length || state.ws.readyState !== WebSocket.OPEN) return;

    sendTickerMessage(state.ws, { a: 'subscribe', v: normalized });
    sendTickerMessage(state.ws, { a: 'mode', v: ['ltp', normalized] });

    for (const token of normalized) {
      state.subscribedTokens.add(token);
      state.pendingTokens.delete(token);
    }
  }

  function on_connect(userId) {
    const state = userTickers.get(userId);
    if (!state) return;

    state.retries = 0;
    const pending = [...state.pendingTokens];
    if (pending.length) {
      subscribeTokens(userId, pending);
    }
    console.log(`Ticker connected for user ${userId}`);
  }

  function on_ticks(userId, ticks = []) {
    if (!Array.isArray(ticks) || ticks.length === 0) return;

    let ltpMap = userLtpCache.get(userId);
    if (!ltpMap) {
      ltpMap = new Map();
      userLtpCache.set(userId, ltpMap);
    }

    for (const tick of ticks) {
      const token = normalizeToken(tick.instrument_token);
      const price = Number(tick.last_price);
      if (!token || Number.isNaN(price)) continue;
      ltpMap.set(token, price);
    }

    resolveLtpWaiters(userId);
  }

  function connectTicker(userId, tokens = []) {
    const accessToken = getAccessToken(userId);
    if (!accessToken || !apiKey) return;

    const existing = userTickers.get(userId);
    if (existing?.ws && (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING)) {
      subscribeTokens(userId, tokens);
      return;
    }

    const socketUrl = `${wsUrl}?api_key=${encodeURIComponent(apiKey)}&access_token=${encodeURIComponent(accessToken)}`;
    const ws = new WebSocket(socketUrl);
    const state = {
      ws,
      subscribedTokens: new Set(),
      pendingTokens: new Set(tokens.map(normalizeToken).filter(Boolean)),
      retries: existing?.retries || 0,
      reconnectTimer: null,
      shouldReconnect: true
    };

    userTickers.set(userId, state);

    ws.on('open', () => {
      on_connect(userId);
    });

    ws.on('message', (data) => {
      if (!Buffer.isBuffer(data)) {
        const text = typeof data === 'string' ? data : data?.toString?.('utf8');
        if (text) {
          try {
            const parsed = JSON.parse(text);
            if (parsed?.type === 'error' || parsed?.error_type || parsed?.message) {
              console.error(`Ticker text message for user ${userId}:`, parsed);
            }
          } catch {
            // Non-JSON text packets can be ignored.
          }
        }
        return;
      }
      const ticks = parseTicks(data);
      if (ticks.length) {
        on_ticks(userId, ticks);
      }
    });

    ws.on('unexpected-response', (_request, response) => {
      const statusCode = response?.statusCode || 0;
      const statusMessage = response?.statusMessage || '';
      console.error(`Ticker unexpected response for user ${userId}: ${statusCode} ${statusMessage}`);

      if (statusCode === 401 || statusCode === 403) {
        const current = userTickers.get(userId);
        if (current) current.shouldReconnect = false;
      }
    });

    ws.on('error', (err) => {
      const message = getErrorMessage(err);
      console.error(`Ticker error for user ${userId}: ${message}`);

      if (message.includes('401') || message.includes('403') || message.toLowerCase().includes('forbidden')) {
        const current = userTickers.get(userId);
        if (current) current.shouldReconnect = false;
      }
    });

    ws.on('close', (code, reasonBuffer) => {
      const nextState = userTickers.get(userId);
      if (!nextState) return;

      const reason = reasonBuffer ? reasonBuffer.toString('utf8') : '';
      if (code || reason) {
        console.error(`Ticker closed for user ${userId}: code=${code || 'n/a'} reason=${reason || 'n/a'}`);
      }

      if (!nextState.shouldReconnect) {
        return;
      }

      const retryCount = (nextState.retries || 0) + 1;
      nextState.retries = retryCount;

      if (retryCount > 5) {
        console.error(`Ticker reconnect limit reached for user ${userId}`);
        return;
      }

      const reconnectDelayMs = Math.min(1000 * retryCount, 5000);
      nextState.reconnectTimer = setTimeout(() => {
        const reconnectTokens = [...nextState.subscribedTokens, ...nextState.pendingTokens];
        connectTicker(userId, reconnectTokens);
      }, reconnectDelayMs);
    });
  }

  function closeTicker(userId) {
    const state = userTickers.get(userId);
    if (!state) return;

    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
    }

    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.close();
    }
    userTickers.delete(userId);
  }

  function getLtpMap(userId) {
    return userLtpCache.get(userId);
  }

  function clearLtpCache(userId) {
    userLtpCache.delete(userId);
  }

  function waitForLtp(userId, { timeoutMs = 1500 } = {}) {
    const ltpMap = userLtpCache.get(userId);
    if (ltpMap?.size) {
      return Promise.resolve(ltpMap);
    }

    return new Promise((resolve) => {
      const waiters = ltpWaiters.get(userId) || new Set();
      const finish = (value) => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) {
          ltpWaiters.delete(userId);
        }
        resolve(value);
      };
      const timer = setTimeout(() => finish(userLtpCache.get(userId)), timeoutMs);

      waiters.add(finish);
      ltpWaiters.set(userId, waiters);
    });
  }

  return {
    connectTicker,
    closeTicker,
    getLtpMap,
    clearLtpCache,
    waitForLtp
  };
}
