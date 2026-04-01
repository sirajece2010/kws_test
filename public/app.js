console.log('app.js loaded');
const API = '/api';
const tbody = document.getElementById('tbody');
const searchInput = document.getElementById('search');
const createForm = document.getElementById('create-form');
const newName = document.getElementById('new-name');
const newSerial = document.getElementById('new-serial');
const newStrike = document.getElementById('new-strike');
const newQuantity = document.getElementById('new-quantity');
const createBtn = document.getElementById('create-btn');
const authBtn = document.getElementById('auth-btn');
const getPortfolioBtn = document.getElementById('get-portfolio-btn');
const portfolioSelect = document.getElementById('portfolio-select');
const statusEl = document.getElementById('status');
const toggleBtn = document.getElementById('theme-toggle');

const userSelect = document.getElementById('user-select');
const switchUserBtn = document.getElementById('switch-user-btn');
let currentUser = localStorage.getItem('currentUser') || null;

// Initialise username label from persisted session
(function () {
  const label = document.getElementById('username-label');
  if (label && currentUser) label.textContent = currentUser;
})();

function setCurrentUser(username) {
  currentUser = username;
  localStorage.setItem('currentUser', username);
  userSelect.value = username;
  const label = document.getElementById('username-label');
  if (label) label.textContent = username || 'Guest';
}

function saveAccessToken(username, token) {
  if (!username) return;
  localStorage.setItem('accessToken_' + username, token);
}

function getAccessToken(username) {
  if (!username) return null;
  const token = localStorage.getItem('accessToken_' + username);
  if (!token || token === 'null' || token === 'undefined') return null;
  return token;
}

function savePortfolioId(username, portfolioId) {
  if (!username || !portfolioId) return;
  localStorage.setItem('portfolioId_' + username, portfolioId);
}

function getPortfolioId(username) {
  if (!username) return null;
  return localStorage.getItem('portfolioId_' + username);
}

function clearUserData(username = null) {
  if (username) {
    // Clear specific user's data
    localStorage.removeItem('accessToken_' + username);
    localStorage.removeItem('portfolioId_' + username);
    console.log(`Cleared data for user: ${username}`);
  } else {
    // Clear all user-related keys
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith('accessToken') || key.startsWith('portfolioId')) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
    localStorage.removeItem('currentUser');
    console.log(`Cleared all user data. Removed keys: ${keysToRemove.join(', ')}`);
  }
}

switchUserBtn.addEventListener('click', async () => {
  //clearUserData(currentUser);
  const username = userSelect.value.trim();
  if (!username) return setStatus('Please select a user', true);
  
  const token = getAccessToken(username);
  if (!token) {
    return setStatus(`User ${username} not authenticated. Click "Authenticate" first.`, true);
  }
  
  // Clear and reset portfolio dropdown
  portfolioSelect.innerHTML = '';
  const opt = document.createElement('option');
  opt.value = '';
  opt.textContent = 'Select Portfolio';
  portfolioSelect.appendChild(opt);
  
  setCurrentUser(username);
  
  // Try to restore saved portfolio for this user
  const savedPortfolioId = getPortfolioId(username);
  if (savedPortfolioId) {
    try {
      await postJSON(`${API}/setPortfolioId`, { portfolioId: savedPortfolioId });
      portfolioSelect.value = savedPortfolioId;
    } catch (e) {
      console.warn('Could not restore portfolio:', e.message);
    }
  }
  
  try {
    await refresh();
    setStatus(`Switched to user: ${username}`, false);
  } catch (e) {
    setStatus(parseError(e), true);
  }
});

let devices = [];

searchInput.addEventListener('input', () => render());

createBtn.addEventListener('click', async () => {
  const symbol = newName.value.trim();
  const token = newSerial.value.trim();
  const strike = newStrike.value.trim();
  const quantity = newQuantity.value.trim();
  if (!symbol || !token) return setStatus('Symbol and Token are required', true);

  try {
    await postJSON(`${API}/devices`, { symbol, token, strike, quantity });
    newName.value = ''; newSerial.value = '';
    await refresh();
    setStatus('Instrument added', false);
  } catch (e) {
    setStatus(parseError(e), true);
  }
});

authBtn.addEventListener('click', async () => {
  try {
    if (!currentUser) return setStatus('Select a user before authenticating', true);
    const secretKey = prompt('Enter the secret key to Authenticate:');
    if (!secretKey || !secretKey.trim()) return setStatus('Secret key is required', true);

    const token = secretKey.trim();
    const res = await postJSON(`${API}/authenticate`, { secretkey: token });
    saveAccessToken(currentUser, token);
    setStatus(`Authentication Code: ${res.code}`, false);
  } catch (e) {
    setStatus(parseError(e), true);
  }
});

getPortfolioBtn.addEventListener('click', async () => {
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
});

portfolioSelect.addEventListener('change', async ()  => {
  try {
    const portfolioId = portfolioSelect.value;
    const portfolioName = portfolioSelect.options[portfolioSelect.selectedIndex].textContent;
    if (!portfolioId || !portfolioId.trim()) return;
    
    await postJSON(`${API}/setPortfolioId`, { portfolioId: portfolioId.trim() });
    savePortfolioId(currentUser, portfolioId.trim());
    
    await refresh();
    setStatus(`Portfolio set to: ${portfolioName.trim()}`, false);
  } catch (e) {
    setStatus(parseError(e), true);
  }
});

// --- main functions ---

async function refresh() {
  try {
    //devices = await getJSON(`${API}/devices`);
    console.log('Fetching portfolio data...');
    devices = await getJSON(`${API}/portfolio`);;
    //result = await postJSON(`${API}/devices/sync`, { devices });
    //setStatus(`Sync result: ${JSON.stringify(result)}`, false);
    render();
  } catch (e) {
    setStatus(parseError(e), true);
  }
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  const rows = !q
    ? devices
    : devices.filter(d => (d.symbol + ' ' + d.token).toLowerCase().includes(q));

  tbody.innerHTML = '';
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
      const losts = prompt('How many lots to add?');
      if (!losts || !losts.trim()) return;
      try {
        await postJSON(`${API}/devices/${d.id}/addmore`, { symbol: d.symbol, lots: losts.trim(), price: d.ltp, lot_size: d.lot_size, type: ordertype });
        await refresh();
        setStatus(`Added ${losts.trim()} lots of ${d.symbol}`, false);
      } catch (e) {
        setStatus(parseError(e), true);
      }
    };

    const exitBtn = document.createElement('button');
    exitBtn.textContent = 'Exit';
    exitBtn.disabled = !allocated;
    exitBtn.onclick = async () => {
      if (!confirm(`Exit ${d.symbol}?`)) return;
      try {
        await postJSON(`${API}/devices/${d.id}/exit`, { symbol: d.symbol, quantity: d.quantity, price: d.ltp, lot_size: d.lot_size, type: ordertype });
        await refresh();
        setStatus(`Exited ${d.symbol}`, false);
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
        await putJSON(`${API}/devices/${d.id}/chsl`, { stop_loss: stoploss.trim(), symbol: d.symbol });
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

function td(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function authHeaders(baseHeaders = {}) {
  const token = getAccessToken(currentUser);
  if (!token) return { ...baseHeaders };
  return {
    ...baseHeaders,
    Authorization: `Bearer ${token}`
  };
}

// --- helpers ---
async function getJSON(url) {
  const res = await fetch(url, {
    headers: authHeaders()
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
    body: JSON.stringify(body || {})
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
    body: JSON.stringify(body || {})
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

// Auto-restore portfolio on page load
async function initializeUser() {
  if (currentUser) {
    const savedPortfolioId = getPortfolioId(currentUser);
    if (savedPortfolioId) {
      try {
        await postJSON(`${API}/setPortfolioId`, { portfolioId: savedPortfolioId });
      } catch (e) {
        console.warn('Could not restore portfolio on load:', e.message);
      }
    }
  }
}

initializeUser().then(() => {
  refresh().catch(err => setStatus(parseError(err), true));
}).catch(err => console.error('Init error:', err));
