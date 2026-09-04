console.log('app.js loaded');
const API = '/api';
const tbody = document.getElementById('tbody');
const searchInput = document.getElementById('search');
const createForm = document.getElementById('create-form');
const newName = document.getElementById('new-name');
const newSerial = document.getElementById('new-serial');
const newStrike = document.getElementById('new-strike');
const newQuantity = document.getElementById('new-quantity');
const authBtn = document.getElementById('auth-btn');
//const getPortfolioBtn = document.getElementById('get-portfolio-btn');
//const portfolioSelect = document.getElementById('portfolio-select');
const statusEl = document.getElementById('status');
const toggleBtn = document.getElementById('theme-toggle');
const obody = document.getElementById('obody');
const refreshOrdersBtn = document.getElementById('refresh-orders-btn');
const ordersStatusEl = document.getElementById('orders-status');
const casTbody = document.getElementById('cas-tbody');
const refreshCasBtn = document.getElementById('refresh-cas-btn');
const casStatusEl = document.getElementById('cas-status');
const startCasCollectorBtn = document.getElementById('start-cas-collector-btn');
const stopCasCollectorBtn = document.getElementById('stop-cas-collector-btn');
const casCollectorStatusEl = document.getElementById('cas-collector-status');
const casSymbolForm = document.getElementById('cas-symbol-form');
const casInstrumentToken = document.getElementById('cas-instrument-token');
const casSymbolName = document.getElementById('cas-symbol-name');
const casCandleTbody = document.getElementById('cas-candle-tbody');
const casCandleInterval = document.getElementById('cas-candle-interval');
const casCandleTable = document.getElementById('cas-candle-table');
const casCandleChart = document.getElementById('cas-candle-chart');
const casCandleViewButtons = document.querySelectorAll('[data-candle-view]');
// Sell SL elements
const sellSlInput = document.getElementById('sell-sl-input');
const saveSellSlBtn = document.getElementById('save-sell-sl-btn');
const sellSlStatusEl = document.getElementById('sell-sl-status');
// Buy SL elements
const buySlInput = document.getElementById('buy-sl-input');
const saveBuySlBtn = document.getElementById('save-buy-sl-btn');
const buySlStatusEl = document.getElementById('buy-sl-status');


const userSelect = document.getElementById('user-select');
const switchUserBtn = document.getElementById('switch-user-btn');
let currentUser = localStorage.getItem('currentUser') || null;
let accessToken  = localStorage.getItem('accessToken')  || null;

// After Kite OAuth callback, ?user=XXX&token=YYY — store both and clean URL
(function () {
  const params = new URLSearchParams(window.location.search);
  const cbUser  = params.get('user');
  const cbToken = params.get('token');
  if (cbUser) {
    currentUser = cbUser;
    localStorage.setItem('currentUser', cbUser);
  }
  if (cbToken) {
    accessToken = cbToken;
    localStorage.setItem('accessToken', cbToken);
  }
  if (cbUser || cbToken) {
    window.history.replaceState({}, '', window.location.pathname);
  }
})();

// Initialise username label from persisted session
(function () {
  const label = document.getElementById('username-label');
  if (label && currentUser) label.textContent = currentUser;
})();

function setCurrentUser(username) {
  currentUser = username;
  localStorage.setItem('currentUser', username);
  // Clear stored token when switching user — new login required
  if (accessToken && username !== localStorage.getItem('currentUser')) {
    accessToken = null;
    localStorage.removeItem('accessToken');
  }
  userSelect.value = username;
  const label = document.getElementById('username-label');
  if (label) label.textContent = username || 'Guest';
}

switchUserBtn.addEventListener('click', async () => {
  const username = userSelect.value.trim();
  if (!username) return setStatus('Please select a user', true);
  setCurrentUser(username);
  // Clear stale device details immediately; only repopulate if the new user has a valid access token
  devices = [];
  render();
  try {
    await refresh();
    await loadOrders();
    setStatus(`Switched to user: ${username}`, false);
  } catch (e) {
    setStatus(`Cannot switch to ${username}: ${parseError(e)}`, true);
  }
});

let devices = [];

searchInput.addEventListener('input', () => render());

authBtn.addEventListener('click', async () => {
  try {
    const selectedUser = (userSelect.value || currentUser || '').trim();
    if (!selectedUser) {
      setStatus('Please select a user before authenticating', true);
      return;
    }
    setCurrentUser(selectedUser);
    const res = await getJSON(`${API}/kite-login-url?userId=${encodeURIComponent(selectedUser)}`);
    if (res.url) {
      window.location.href = res.url;
    } else {
      setStatus('Failed to get Kite login URL', true);
    }
  } catch (e) {
    setStatus(parseError(e), true);
  }
});


/*getPortfolioBtn.addEventListener('click', async () => {
  try {
    const res = await postJSON(`${API}/getPortfolioId`, { });

    // populate portfolioSelect with names from response
    const list = Array.isArray(res)
      ? res
      : Array.isArray(res.portfolios)
      ? res.portfolios
      : Array.isArray(res.data)
        ? res.data
        : [];

    portfolioSelect.innerHTML = '';
    if (list.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No portfolios found';
      portfolioSelect.appendChild(opt);
      setStatus('No portfolios found or invalid access token or create a new portfolio.', true);
      return;
    }
    list.forEach(val => {
      const opt = document.createElement('option');
      opt.value = val.id ?? JSON.stringify(val);
      opt.textContent = val.name ?? JSON.stringify(val);
      portfolioSelect.appendChild(opt);
    });
    setStatus(`${list.length} Portfolios loaded`, false);
    //setStatus(`Portfolio Data: ${JSON.stringify(res)}`, false, true);
  } catch (e) {
    setStatus(parseError(e), true);
  }
});*/

// --- main functions ---

async function refresh() {
  try {
    //devices = await getJSON(`${API}/devices`);
    console.log('Fetching portfolio data...');
    devices = await getJSON(`${API}/portfolio`);;
    setStatus(`Portfolio data refreshed. ${devices.length} devices loaded.`, false);
    //result = await postJSON(`${API}/devices/sync`, { devices });
    //setStatus(`Sync result: ${JSON.stringify(result)}`, false);
    render();
  } catch (e) {
    devices = [];
    render();
    setStatus(parseError(e), true);
  }
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  const rows = !q
    ? devices
    : devices.filter(d => (d.symbol + ' ' + d.token).toLowerCase().includes(q));

  tbody.innerHTML = '';
  if (rows.length === 0) {
    const tr = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 15;
    cell.textContent = 'No data found.';
    cell.style.textAlign = 'center';
    tr.appendChild(cell);
    tbody.appendChild(tr);
  }
  else {
    rows.forEach(d => {
      const tr = document.createElement('tr');
      //const isDark = document.documentElement.classList.contains('theme-dark');
      const isDark = document.documentElement.classList.contains('theme-dark') ? true : false;
      console.log('isDark:', isDark);
      //tr.style.backgroundColor = d.unbooked > 0 ? '#58fa65ff' : d.unbooked < 0 ? '#f72f4dff' : '#ffffff';
      tr.style.backgroundColor = d.unbooked > 0 ? (isDark ? '#145214' : '#e8f5e9') : d.unbooked < 0 ? (isDark ? '#5c121f' : '#ffebee') : (isDark ? '#333333' : '#ffffff');

      const ordertype = d.quantity === 0 ? '—' : (d.quantity > 0 ? 'BUY' : 'SELL');
      tr.appendChild(td(d.id));
      tr.appendChild(td(d.symbol));
      tr.appendChild(td(d.token));
      tr.appendChild(td(ordertype));

      const statusTd = document.createElement('td');
      const allocated = !!(d.quantity && d.quantity !== 0);
      const hasstoploss = !!d.stop_loss;
      const badge = document.createElement('span');
      badge.className = `badge ${allocated ? 'allocated' : 'available'}`;
      badge.textContent = allocated ? 'Open' : 'Closed';
      statusTd.appendChild(badge);
      tr.appendChild(statusTd);

      tr.appendChild(td(d.strike|| '—'));
      tr.appendChild(td(d.quantity|| '—'));
      tr.appendChild(td(d.avg_price|| '0'));
      tr.appendChild(td(Number(d.ltp).toFixed(2)|| '—'));
      tr.appendChild(td(d.booked|| '0'));
      tr.appendChild(td(d.unbooked|| '0'));
      tr.appendChild(td(d.stop_loss|| '—'));
      tr.appendChild(td(d.total ? d.total : (d.booked + d.unbooked)|| '0'));
      tr.appendChild(td(d.expiry|| '—'));

      const actionsTd = document.createElement('td');
      actionsTd.className = 'actions';
      const addBtn = document.createElement('button');
      addBtn.textContent = 'Add';
      addBtn.disabled = !allocated;
      addBtn.onclick = async () => {
        const losts = prompt('How many lots to add?', '1');
        if (!losts || !losts.trim()) return;
        try {
          await postJSON(`${API}/devices/${d.id}/addmore`, { symbol: d.symbol, lots: losts.trim(), price: d.ltp, lot_size: d.lot_size, type: ordertype });
          await refresh();
          setStatus(`Create Order added ${losts.trim()} lots of ${d.symbol}`, false);
        } catch (e) {
          setStatus(parseError(e), true);
        }
      };

      const exitBtn = document.createElement('button');
      exitBtn.textContent = 'Exit';
      exitBtn.disabled = !allocated;
      exitBtn.onclick = async () => {
        const price = prompt('Enter exit price:', d.ltp);
        let OrderType = 'LIMIT';
        if (!price || !price.trim()) return;
        if (!confirm(`Exit ${d.symbol} at price ${price.trim()}?`)) return;
        if ((d.ltp < price.trim() && ordertype === 'SELL') || (d.ltp > price.trim() && ordertype === 'BUY')) {
          OrderType = 'SL';
        }
        try {
          await postJSON(`${API}/devices/${d.id}/exit`, { symbol: d.symbol, quantity: d.quantity, price: Number(price), lot_size: d.lot_size, type: ordertype, ordertype: OrderType });
          await refresh();
          if (OrderType === 'SL') {
            setStatus(`SL order created for ${d.symbol}`, false);
          } else {
            setStatus(`Exit order created for ${d.symbol}`, false);
          }
        } catch (e) {
          setStatus(parseError(e), true);
        }
      };
      const chownBtn = document.createElement('button');
      chownBtn.textContent = 'Modify SL';
      //chownBtn.disabled = !hasstoploss;
      chownBtn.disabled = true;
      chownBtn.onclick = async () => {
          const stoploss = prompt('Enter the new Stop Loss value:');
        if (!stoploss || !stoploss.trim()) return;
        try {
          await putJSON(`${API}/devices/${d.id}/chsl`, { stop_loss: Number(stoploss.trim()), symbol: d.symbol });
          await refresh();
          setStatus(`StopLoss Updated to ${stoploss.trim()}`, false);
        } catch (e) {
          setStatus(parseError(e), true);
        }
      };
      

      actionsTd.appendChild(addBtn);
      actionsTd.appendChild(exitBtn);
      actionsTd.appendChild(chownBtn);
      tr.appendChild(actionsTd);

      tbody.appendChild(tr);
    });
  }
}

function td(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function authHeaders(baseHeaders = {}) {
  const headers = {
    ...baseHeaders,
    'X-User-Id': currentUser || ''
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  return headers;
}

// --- helpers ---
async function getJSON(url) {
  const res = await fetch(url, {
    headers: authHeaders(),
    credentials: 'include'
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders({
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(body || {}),
    credentials: 'include'
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json().catch(() => ({})); // some endpoints return 204
}
async function putJSON(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: authHeaders({
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(body || {}),
    credentials: 'include'
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json().catch(() => ({})); // handles empty response
}
function setStatus(msg, isError, persist = false) {
  statusEl.textContent = msg || '';
  statusEl.className = isError ? 'error' : 'success';
  if (!persist) {
    // clear status after 3 seconds
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = '';
    }, 3000);
  }
}

function parseError(e) {
  try {
    const obj = JSON.parse(e.message);
    return obj.error || e.message;
  } catch {
    return e.message;
  }
}

async function loadSellSLPercent() {
  if (!sellSlInput) return;
  try {
    const res = await getJSON(`${API}/settings/sell-sl-percent`);
    if (typeof res.sellSlPercent === 'number') {
      sellSlInput.value = String(res.sellSlPercent);
    }
  } catch (e) {
    if (sellSlStatusEl) {
      sellSlStatusEl.textContent = `Failed to load SELL SL: ${parseError(e)}`;
      sellSlStatusEl.className = 'error';
    }
  }
}

async function loadBuySLPercent() {
  if (!buySlInput) return;
  try {
    const res = await getJSON(`${API}/settings/buy-sl-percent`);
    if (typeof res.buySlPercent === 'number') {
      buySlInput.value = String(res.buySlPercent);
    }
  } catch (e) {
    if (buySlStatusEl) {
      buySlStatusEl.textContent = `Failed to load BUY SL: ${parseError(e)}`;
      buySlStatusEl.className = 'error';
    }
  }
}

saveSellSlBtn?.addEventListener('click', async () => {
  try {
    const nextValue = Number(sellSlInput?.value);
    if (Number.isNaN(nextValue) || nextValue < 0.5 || nextValue > 2) {
      if (sellSlStatusEl) {
        sellSlStatusEl.textContent = 'SELL SL must be between 0.5 and 2';
        sellSlStatusEl.className = 'error';
      }
      return;
    }

    const res = await putJSON(`${API}/settings/sell-sl-percent`, {
      sellSlPercent: nextValue
    });

    if (sellSlStatusEl) {
      sellSlStatusEl.textContent = `SELL SL updated to ${res.sellSlPercent}`;
      sellSlStatusEl.className = 'success';
    }

    await refresh();
  } catch (e) {
    if (sellSlStatusEl) {
      sellSlStatusEl.textContent = parseError(e);
      sellSlStatusEl.className = 'error';
    }
  }
});

saveBuySlBtn?.addEventListener('click', async () => {
  try {
    const nextValue = Number(buySlInput?.value);
    if (Number.isNaN(nextValue) || nextValue < 0.6 || nextValue > 1) {
      if (buySlStatusEl) {
        buySlStatusEl.textContent = 'BUY SL must be between 0.6 and 1';
        buySlStatusEl.className = 'error';
      }
      return;
    }

    const res = await putJSON(`${API}/settings/buy-sl-percent`, {
      buySlPercent: nextValue
    });

    if (buySlStatusEl) {
      buySlStatusEl.textContent = `BUY SL updated to ${res.buySlPercent}`;
      buySlStatusEl.className = 'success';
    }

    await refresh();
  } catch (e) {
    if (buySlStatusEl) {
      buySlStatusEl.textContent = parseError(e);
      buySlStatusEl.className = 'error';
    }
  }
});

// --- navigation and subtabs ---
function initPrimaryNavigation() {
  const navLinks = Array.from(document.querySelectorAll('.dummy-nav a[data-tab-target]'));
  const primaryPanels = Array.from(document.querySelectorAll('.primary-panel'));
  if (!navLinks.length || !primaryPanels.length) return;

  function activatePrimaryPanel(targetId) {
    if (!targetId) return;

    navLinks.forEach(link => {
      const isActive = link.getAttribute('data-tab-target') === targetId;
      link.setAttribute('aria-current', isActive ? 'page' : 'false');
    });

    primaryPanels.forEach(panel => {
      panel.classList.toggle('active', panel.id === targetId);
    });
  }

  navLinks.forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      activatePrimaryPanel(link.getAttribute('data-tab-target'));
    });
  });
}

function initSubtabs() {
  const subtabGroups = Array.from(document.querySelectorAll('[data-subtabs]'));

  subtabGroups.forEach(group => {
    const subtabButtons = Array.from(group.querySelectorAll('.subtab-btn[data-subtab-target]'));
    const parentPanel = group.closest('.primary-panel');
    const subtabPanels = parentPanel
      ? Array.from(parentPanel.querySelectorAll('.subtab-panel'))
      : [];

    if (!subtabButtons.length || !subtabPanels.length) return;

    function activateSubtab(targetId) {
      if (!targetId) return;

      subtabButtons.forEach(button => {
        const isActive = button.getAttribute('data-subtab-target') === targetId;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });

      subtabPanels.forEach(panel => {
        panel.classList.toggle('active', panel.id === targetId);
      });
    }

    subtabButtons.forEach(button => {
      button.addEventListener('click', () => {
        activateSubtab(button.getAttribute('data-subtab-target'));
      });
    });
  });
}

initPrimaryNavigation();
initSubtabs();

document.querySelector('[data-tab-target="panel-cas-app"]')?.addEventListener('click', () => {
  loadCasTicks();
  loadCasCollectorStatus();
});

refreshCasBtn?.addEventListener('click', () => loadCasTicks());

startCasCollectorBtn?.addEventListener('click', async () => {
  try {
    await postJSON(`${API}/cas/collector/start`);
    await loadCasCollectorStatus();
  } catch (e) {
    setCasCollectorStatus(parseError(e), true);
  }
});

stopCasCollectorBtn?.addEventListener('click', async () => {
  try {
    await postJSON(`${API}/cas/collector/stop`);
    await loadCasCollectorStatus();
  } catch (e) {
    setCasCollectorStatus(parseError(e), true);
  }
});

casSymbolForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await postJSON(`${API}/cas/symbols`, {
      instrumentToken: casInstrumentToken?.value,
      symbol: casSymbolName?.value
    });
    casSymbolForm.reset();
    setCasCollectorStatus(`${result.symbol} will be subscribed on the next collector cycle.`, false);
  } catch (e) {
    setCasCollectorStatus(parseError(e), true);
  }
});

document.querySelector('[data-subtab-target="cas-candle"]')?.addEventListener('click', () => {
  loadCasCandles();
});

casCandleInterval?.addEventListener('change', () => {
  loadCasCandles();
});

casCandleViewButtons.forEach((button) => {
  button.addEventListener('click', () => setCasCandleView(button.dataset.candleView));
});

let casLoadInFlight = false;
let casCandleLoadInFlight = false;
let casCandles = [];
let casCandleChartInstances = [];

function setCasCollectorStatus(message, isError) {
  if (!casCollectorStatusEl) return;
  casCollectorStatusEl.textContent = message;
  casCollectorStatusEl.className = isError ? 'error' : 'success';
}

async function loadCasCollectorStatus() {
  try {
    const { running } = await getJSON(`${API}/cas/collector`);
    startCasCollectorBtn.disabled = running;
    stopCasCollectorBtn.disabled = !running;
    setCasCollectorStatus(running ? 'Collector running' : 'Collector stopped', false);
  } catch (e) {
    setCasCollectorStatus(`Collector status unavailable: ${parseError(e)}`, true);
  }
}

function formatCasTime(value) {
  if (!value) return '—';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function isCasAutoRefreshWindow() {
  const timeParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const hour = Number(timeParts.find(({ type }) => type === 'hour')?.value);
  const minute = Number(timeParts.find(({ type }) => type === 'minute')?.value);
  const currentMinute = hour * 60 + minute;
  //return currentMinute >= 14 * 60 + 55 && currentMinute < 15 * 60 + 40;
  return currentMinute >= 10 * 60 + 24 && currentMinute < 15 * 60 + 50;
}

async function loadCasTicks() {
  if (!casTbody || !casStatusEl || casLoadInFlight) return;

  casLoadInFlight = true;
  void loadCasCandles();
  casStatusEl.textContent = 'Loading...';
  casStatusEl.className = 'muted';
  try {
    const rows = await getJSON(`${API}/cas/ticks?limit=10`);
    casTbody.innerHTML = '';

    if (rows.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 12;
      cell.textContent = 'No CAS data found.';
      cell.style.textAlign = 'center';
      row.appendChild(cell);
      casTbody.appendChild(row);
    } else {
      rows.forEach((tick) => {
        const row = document.createElement('tr');
        var direction = Number(tick.change_delta) > 0 ? 'Long' : Number(tick.change_delta) < 0 ? 'Short' : 'Neutral';
        if (tick.symbol.endsWith("PE")) direction = direction === 'Long' ? 'Short' : direction === 'Short' ? 'Long' : 'Neutral';
        [
          formatCasTime(tick.time),
          tick.symbol,
          tick.ltp,
          tick.open,
          tick.high,
          tick.low,
          tick.close,
          tick.volume,
          tick.change,
          tick.change_delta,
          tick.volume_delta,
          direction
        ].forEach((value, index) => {
          const cell = td(value ?? '—');
          if (index === 11) {
            cell.style.color = direction === 'Long' ? 'green' : direction === 'Short' ? 'red' : 'grey';
            cell.style.fontWeight = '600';
          }
          row.appendChild(cell);
        });
        casTbody.appendChild(row);
      });
    }
    casStatusEl.textContent = `${rows.length} row(s) loaded.`;
    casStatusEl.className = 'success';
  } catch (e) {
    casStatusEl.textContent = `Failed to load CAS data: ${parseError(e)}`;
    casStatusEl.className = 'error';
  } finally {
    casLoadInFlight = false;
  }
}

async function loadCasCandles() {
  if (!casCandleTbody || casCandleLoadInFlight) return;

  casCandleLoadInFlight = true;
  try {
    const interval = encodeURIComponent(casCandleInterval?.value || '3 min');
    const rows = await getJSON(`${API}/cas/candles?interval=${interval}`);
    casCandles = rows;
    casCandleTbody.innerHTML = '';

    if (rows.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 7;
      cell.textContent = 'No candlestick data found for the last 15 minutes.';
      cell.style.textAlign = 'center';
      row.appendChild(cell);
      casCandleTbody.appendChild(row);
      return;
    }

    rows.forEach((candle) => {
      const row = document.createElement('tr');
      [
        formatCasTime(candle.tm),
        candle.symbol,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume
      ].forEach((value) => row.appendChild(td(value ?? '—')));
      casCandleTbody.appendChild(row);
    });
    renderCasCandleChart();
  } catch (e) {
    casCandleTbody.innerHTML = '';
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.textContent = `Failed to load candlestick data: ${parseError(e)}`;
    cell.className = 'error';
    row.appendChild(cell);
    casCandleTbody.appendChild(row);
  } finally {
    casCandleLoadInFlight = false;
  }
}

function setCasCandleView(view) {
  const showChart = view === 'chart';
  casCandleViewButtons.forEach((button) => {
    const isActive = button.dataset.candleView === view;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
  casCandleTable?.classList.toggle('hidden', showChart);
  casCandleChart?.classList.toggle('active', showChart);
  if (showChart) renderCasCandleChart();
}

function renderCasCandleChart() {
  if (!casCandleChart || !window.LightweightCharts) return;

  casCandleChartInstances.forEach((chart) => chart.remove());
  casCandleChartInstances = [];
  casCandleChart.innerHTML = '';

  const symbolWeights = new Map();
  casCandles.forEach((candle) => {
    const weight = Number(candle.weight);
    if (candle.symbol && Number.isFinite(weight)) {
      symbolWeights.set(candle.symbol, Math.max(symbolWeights.get(candle.symbol) ?? -Infinity, weight));
    }
  });
  const symbols = [...new Set(casCandles.map((candle) => candle.symbol).filter(Boolean))]
    .sort((first, second) => (symbolWeights.get(second) ?? 0) - (symbolWeights.get(first) ?? 0) || first.localeCompare(second));
  symbols.forEach((symbol) => {
    const candles = casCandles
      .filter((candle) => candle.symbol === symbol)
      .map((candle) => ({
        time: Math.floor(new Date(candle.tm).getTime() / 1000),
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close)
      }))
      .filter((candle) => Number.isFinite(candle.time) && Object.values(candle).every((value) => typeof value === 'number' && Number.isFinite(value)))
      .sort((first, second) => first.time - second.time);

    if (!candles.length) return;

    const tile = document.createElement('section');
    tile.className = 'candlestick-chart-tile';
    const title = document.createElement('h3');
    title.className = 'candlestick-chart-title';
    title.textContent = symbol;
    const host = document.createElement('div');
    host.className = 'candlestick-chart-host';
    tile.append(title, host);
    casCandleChart.appendChild(tile);

    const chart = window.LightweightCharts.createChart(host, {
      autoSize: true,
      layout: { background: { color: '#ffffff' }, textColor: '#333333' },
      timeScale: { timeVisible: true, secondsVisible: false },
      localization: {
        timeFormatter: (timestamp) => new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }).format(new Date(timestamp * 1000))
      }
    });
    const series = chart.addSeries(window.LightweightCharts.CandlestickSeries, {
      upColor: '#0a7a2f',
      downColor: '#c62828',
      borderVisible: false,
      wickUpColor: '#0a7a2f',
      wickDownColor: '#c62828'
    });
    series.setData(candles);
    chart.timeScale().fitContent();
    casCandleChartInstances.push(chart);
  });
}

setInterval(() => {
  if (isCasAutoRefreshWindow()) loadCasTicks();
}, 500);

// Load orders when the Orders subtab is clicked
document.querySelector('[data-subtab-target="inventory-orders"]')?.addEventListener('click', () => {
  loadOrders();
});

// Refresh portfolio data when Inventory Positions subtab is clicked
document.querySelector('[data-subtab-target="inventory-positions"]')?.addEventListener('click', () => {
  refresh();
});

refreshOrdersBtn?.addEventListener('click', () => loadOrders());

async function loadOrders() {
  try {
    ordersStatusEl.textContent = 'Loading...';
    ordersStatusEl.className = 'muted';
    const res = await getJSON(`${API}/orders`);
    const orders = Array.isArray(res) ? res : (res.orders || []);
    obody.innerHTML = '';
    if (orders.length === 0) {
      const tr = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 9;
      cell.textContent = 'No orders found.';
      cell.style.textAlign = 'center';
      tr.appendChild(cell);
      obody.appendChild(tr);
    } else {
      orders.forEach(o => {
        const tr = document.createElement('tr');
        tr.appendChild(td(o.order_timestamp));
        tr.appendChild(td(o.trading_symbol || o.symbol || '—'));
        tr.appendChild(td(o.transaction_type || o.type || '—'));
        tr.appendChild(td(o.strike || '—'));
        tr.appendChild(td(o.quantity || '—'));
        tr.appendChild(td(o.price || '—'));
        tr.appendChild(td(o.placed_by || '—'));
        tr.appendChild(td(o.status || '—'));
        tr.appendChild(td(o.sensibull_order_state || '—'));
        obody.appendChild(tr);
      });
    }
    ordersStatusEl.textContent = `${orders.length} order(s) loaded.`;
    ordersStatusEl.className = 'success';
    setTimeout(() => { ordersStatusEl.textContent = ''; ordersStatusEl.className = ''; }, 3000);
  } catch (e) {
    ordersStatusEl.textContent = parseError(e);
    ordersStatusEl.className = 'error';
  }
}

refresh().catch(err => setStatus(parseError(err), true));
loadSellSLPercent().catch(err => {
  if (sellSlStatusEl) {
    sellSlStatusEl.textContent = parseError(err);
    sellSlStatusEl.className = 'error';
  }
});
loadBuySLPercent().catch(err => {
  if (buySlStatusEl) {
    buySlStatusEl.textContent = parseError(err);
    buySlStatusEl.className = 'error';
  }
});