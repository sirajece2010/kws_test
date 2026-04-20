import 'dotenv/config';
import { createWebsocketManager, normalizeToken } from './websocket.js';

const USER_ID = process.env.WS_TEST_USER_ID || 'UVP969';
const ACCESS_TOKEN = process.env.KITE_ACCESS_TOKEN || process.env.WS_TEST_ACCESS_TOKEN;
const API_KEY = process.env.KITE_API_KEY || process.env.WS_TEST_API_KEY || 'uf8cguv719djhxfc';
const TIMEOUT_MS = Number(process.env.WS_TEST_TIMEOUT_MS || 5000);
const rawTokens = process.env.WS_TEST_TOKENS || process.argv[2] || '';
const TOKENS = rawTokens
  .split(',')
  .map((value) => normalizeToken(value.trim()))
  .filter(Boolean);

if (!ACCESS_TOKEN) {
  console.error('Missing KITE_ACCESS_TOKEN or WS_TEST_ACCESS_TOKEN');
  process.exit(1);
}

if (!TOKENS.length) {
  console.error('Missing instrument token. Set WS_TEST_TOKENS=256265 or pass a comma-separated token list as the first argument.');
  process.exit(1);
}

const manager = createWebsocketManager({
  getAccessToken: (userId) => (userId === USER_ID ? ACCESS_TOKEN : null),
  apiKey: API_KEY
});

try {
  console.log(`userid   : ${USER_ID}`);
  console.log(`api_key   : ${API_KEY}`);
  console.log(`token     : ${ACCESS_TOKEN.slice(0, 6)}...${ACCESS_TOKEN.slice(-4)} (length=${ACCESS_TOKEN.length})`);
  console.log(`Connecting websocket for ${USER_ID} with tokens: ${TOKENS.join(', ')}`);
  manager.connectTicker(USER_ID, TOKENS);

  const ltpMap = await manager.waitForLtp(USER_ID, { timeoutMs: TIMEOUT_MS });

  if (!ltpMap || ltpMap.size === 0) {
    console.error(`No websocket ticks received within ${TIMEOUT_MS}ms`);
    process.exitCode = 1;
  } else {
    for (const token of TOKENS) {
      const ltp = ltpMap.get(token);
      console.log(`token=${token} ltp=${ltp ?? 'missing'}`);
    }
  }
} catch (error) {
  console.error('Standalone websocket test failed:', error?.message || error);
  process.exitCode = 1;
} finally {
  manager.closeTicker(USER_ID);
}