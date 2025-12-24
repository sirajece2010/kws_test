// Scalping configuration
const SCALPING_CONFIG = {
  profitTarget: 0.25,        // 25% profit target
  stopLoss: 0.15,            // 15% stop loss
  trailingStop: 0.10,        // 10% trailing stop
  maxPositionSize: 5,        // Maximum lots per position
  minPremium: 10,            // Minimum option premium to trade
  maxPremium: 200,           // Maximum option premium to trade
  scalingFactor: 1.5,        // Scale out factor
  checkInterval: 2000,       // Check every 2 seconds
  tradingStartTime: { h: 9, m: 30 },   // 9:30 AM IST
  tradingEndTime: { h: 15, m: 0 },     // 3:00 PM IST
  squareOffTime: { h: 15, m: 15 }      // 3:15 PM force square off
};

// Track scalping state per position
const scalpingState = new Map();

// Option Scalping Monitor
setInterval(async () => {
  try {
    if (!globalThis.portfolioId) return;

    // Check if within trading hours
    const istTime = getCurrentISTTime();
    if (!isWithinTradingHours(istTime)) {
      // Force square off if after square off time
      if (isAfterSquareOffTime(istTime)) {
        await forceSquareOffAll();
      }
      return;
    }

    const { portfolioData, instrumentData } = await portfolioDetails();
    if (!portfolioData || !instrumentData) return;

    const transformedRows = transformPortfolioResponse(portfolioData);
    const instrumentInfo = transformInstrumentInfo(instrumentData);
    const combined = enrichPortfolioWithInstruments(transformedRows, instrumentInfo);

    for (const position of combined) {
      if (position.quantity === 0) continue;

      await executeScalpingLogic(position);
    }
  } catch (err) {
    console.error('Scalping monitor error:', err);
  }
}, SCALPING_CONFIG.checkInterval);

async function executeScalpingLogic(position) {
  const { symbol, quantity, avg_price, ltp, lot_size } = position;
  const positionKey = symbol;

  // Initialize state if not exists
  if (!scalpingState.has(positionKey)) {
    scalpingState.set(positionKey, {
      entryPrice: avg_price,
      highestPrice: ltp,
      lowestPrice: ltp,
      scaledOut: false,
      partialExit: false
    });
  }

  const state = scalpingState.get(positionKey);
  const isShort = quantity < 0;
  const absQuantity = Math.abs(quantity);

  // Calculate profit/loss percentage
  const pnlPercent = isShort
    ? ((avg_price - ltp) / avg_price) * 100
    : ((ltp - avg_price) / avg_price) * 100;

  // Update highest/lowest prices
  if (isShort) {
    state.lowestPrice = Math.min(state.lowestPrice, ltp);
  } else {
    state.highestPrice = Math.max(state.highestPrice, ltp);
  }

  console.log(`Scalping check: ${symbol} | Entry: ${avg_price} | LTP: ${ltp} | P&L: ${pnlPercent.toFixed(2)}%`);

  // 1. Profit Target - Full Exit
  if (pnlPercent >= SCALPING_CONFIG.profitTarget * 100) {
    console.log(`✅ Profit target hit for ${symbol}: ${pnlPercent.toFixed(2)}%`);
    await exitPosition(position, 'PROFIT_TARGET', absQuantity);
    scalpingState.delete(positionKey);
    return;
  }

  // 2. Stop Loss - Full Exit
  if (pnlPercent <= -SCALPING_CONFIG.stopLoss * 100) {
    console.log(`🛑 Stop loss hit for ${symbol}: ${pnlPercent.toFixed(2)}%`);
    await exitPosition(position, 'STOP_LOSS', absQuantity);
    scalpingState.delete(positionKey);
    return;
  }

  // 3. Partial Profit Booking - Scale Out
  const partialProfitTarget = SCALPING_CONFIG.profitTarget * 100 * 0.6; // 60% of profit target
  if (pnlPercent >= partialProfitTarget && !state.partialExit && absQuantity >= lot_size * 2) {
    const exitQty = Math.floor(absQuantity / 2);
    console.log(`📊 Partial profit booking for ${symbol}: ${pnlPercent.toFixed(2)}% | Exiting: ${exitQty}`);
    await exitPosition(position, 'PARTIAL_PROFIT', exitQty);
    state.partialExit = true;
    return;
  }

  // 4. Trailing Stop Loss
  const trailingStopPercent = SCALPING_CONFIG.trailingStop * 100;
  if (isShort) {
    const pullbackPercent = ((ltp - state.lowestPrice) / state.lowestPrice) * 100;
    if (pnlPercent > 0 && pullbackPercent >= trailingStopPercent) {
      console.log(`📉 Trailing stop hit (short) for ${symbol}: Pullback ${pullbackPercent.toFixed(2)}%`);
      await exitPosition(position, 'TRAILING_STOP', absQuantity);
      scalpingState.delete(positionKey);
      return;
    }
  } else {
    const pullbackPercent = ((state.highestPrice - ltp) / state.highestPrice) * 100;
    if (pnlPercent > 0 && pullbackPercent >= trailingStopPercent) {
      console.log(`📉 Trailing stop hit (long) for ${symbol}: Pullback ${pullbackPercent.toFixed(2)}%`);
      await exitPosition(position, 'TRAILING_STOP', absQuantity);
      scalpingState.delete(positionKey);
      return;
    }
  }

  // 5. Premium-based exit rules
  if (ltp < SCALPING_CONFIG.minPremium && pnlPercent > 5) {
    console.log(`💰 Premium too low for ${symbol}: ${ltp} | Booking profit`);
    await exitPosition(position, 'LOW_PREMIUM', absQuantity);
    scalpingState.delete(positionKey);
    return;
  }
}

async function exitPosition(position, reason, exitQuantity) {
  const { symbol, quantity, ltp } = position;
  const exitType = quantity < 0 ? "BUY" : "SELL";

  console.log(`🔄 Exiting ${symbol}: ${exitQuantity} lots | Reason: ${reason} | Type: ${exitType}`);

  const ret = await createOrderPayload(exitType, symbol, exitQuantity, ltp);

  if (ret.status) {
    console.log(`✅ Successfully exited ${symbol} | Reason: ${reason}`);
  } else {
    console.error(`❌ Failed to exit ${symbol}:`, ret.error);
  }

  return ret;
}

async function forceSquareOffAll() {
  try {
    const { portfolioData, instrumentData } = await portfolioDetails();
    if (!portfolioData || !instrumentData) return;

    const transformedRows = transformPortfolioResponse(portfolioData);
    const instrumentInfo = transformInstrumentInfo(instrumentData);
    const combined = enrichPortfolioWithInstruments(transformedRows, instrumentInfo);

    for (const position of combined) {
      if (position.quantity !== 0) {
        console.log(`⚠️ Force square off: ${position.symbol}`);
        await exitPosition(position, 'FORCE_SQUARE_OFF', Math.abs(position.quantity));
        scalpingState.delete(position.symbol);
      }
    }
  } catch (err) {
    console.error('Force square off error:', err);
  }
}

// Helper functions
function getCurrentISTTime() {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const [h, m, s] = formatter.format(new Date()).split(':').map(Number);
  return { h, m, s };
}

function isWithinTradingHours(time) {
  const startMinutes = SCALPING_CONFIG.tradingStartTime.h * 60 + SCALPING_CONFIG.tradingStartTime.m;
  const endMinutes = SCALPING_CONFIG.tradingEndTime.h * 60 + SCALPING_CONFIG.tradingEndTime.m;
  const currentMinutes = time.h * 60 + time.m;
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

function isAfterSquareOffTime(time) {
  const squareOffMinutes = SCALPING_CONFIG.squareOffTime.h * 60 + SCALPING_CONFIG.squareOffTime.m;
  const currentMinutes = time.h * 60 + time.m;
  return currentMinutes >= squareOffMinutes;
}

// API endpoint to update scalping config
app.post('/api/scalping/config', async (req, res, next) => {
  try {
    const { profitTarget, stopLoss, trailingStop, maxPositionSize } = req.body;
    
    if (profitTarget) SCALPING_CONFIG.profitTarget = Number(profitTarget);
    if (stopLoss) SCALPING_CONFIG.stopLoss = Number(stopLoss);
    if (trailingStop) SCALPING_CONFIG.trailingStop = Number(trailingStop);
    if (maxPositionSize) SCALPING_CONFIG.maxPositionSize = Number(maxPositionSize);
    
    res.json({ status: 'success', config: SCALPING_CONFIG });
  } catch (err) {
    next(err);
  }
});

// API endpoint to get current scalping state
app.get('/api/scalping/state', async (_req, res, next) => {
  try {
    const states = Array.from(scalpingState.entries()).map(([symbol, state]) => ({
      symbol,
      ...state
    }));
    res.json({ states, config: SCALPING_CONFIG });
  } catch (err) {
    next(err);
  }
});