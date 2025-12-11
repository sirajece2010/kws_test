console.log('app.js loaded');
const API = '/api';
const tbody = document.getElementById('tbody');
const searchInput = document.getElementById('search');
const createForm = document.getElementById('create-form');
const newName = document.getElementById('new-name');
const newSerial = document.getElementById('new-serial');
const newStrike = document.getElementById('new-strike');
const createBtn = document.getElementById('create-btn');
const statusEl = document.getElementById('status');

let devices = [];

searchInput.addEventListener('input', () => render());

createBtn.addEventListener('click', async () => {
  const symbol = newName.value.trim();
  const token = newSerial.value.trim();
  const strike = newStrike.value.trim();
  if (!symbol || !token) return setStatus('Symbol and Token are required', true);

  try {
    await postJSON(`${API}/devices`, { symbol, token, strike});
    newName.value = ''; newSerial.value = '';
    await refresh();
    setStatus('Instrument added', false);
  } catch (e) {
    setStatus(parseError(e), true);
  }
});

async function refresh() {
  try {
    devices = await getJSON(`${API}/devices`);
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

    tr.appendChild(td(d.id));
    tr.appendChild(td(d.symbol));
    tr.appendChild(td(d.token));

    const statusTd = document.createElement('td');
    const allocated = !!d.allocated_to;
    const hasstrike = !!d.strike;
    const badge = document.createElement('span');
    badge.className = `badge ${allocated ? 'allocated' : 'available'}`;
    badge.textContent = allocated ? 'Closed' : 'Open';
    statusTd.appendChild(badge);
    tr.appendChild(statusTd);

    tr.appendChild(td(d.strike|| '—'));
    tr.appendChild(td(d.quantity|| '—'));
    tr.appendChild(td(d.allocated_at ? new Date(d.allocated_at + 'Z').toLocaleString() : '—'));
    tr.appendChild(td(d.allocated_until ? new Date(d.allocated_until + 'Z').toLocaleString() : '—'));

    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions';
    const allotBtn = document.createElement('button');
    allotBtn.textContent = 'Allot';
    allotBtn.disabled = allocated;
    allotBtn.onclick = async () => {
      const username = prompt('Allot to username (e.g., siraj.kamsa)');
      if (!username || !username.trim()) return;
      try {
        await postJSON(`${API}/devices/${d.id}/allot`, { username: username.trim() });
        await refresh();
        setStatus(`Allotted ${d.serial} to ${username.trim()}`, false);
      } catch (e) {
        setStatus(parseError(e), true);
      }
    };

    const releaseBtn = document.createElement('button');
    releaseBtn.textContent = 'Release';
    releaseBtn.disabled = !allocated;
    releaseBtn.onclick = async () => {
      if (!confirm(`Release ${d.serial}?`)) return;
      try {
        await postJSON(`${API}/devices/${d.id}/release`, {});
        await refresh();
        setStatus(`Released ${d.serial}`, false);
      } catch (e) {
        setStatus(parseError(e), true);
      }
    };
    const chownBtn = document.createElement('button');
    chownBtn.textContent = 'Set Owner';
    chownBtn.disabled = hasstrike;
    chownBtn.onclick = async () => {
        const username = prompt('Set Owner to someone (e.g., siraj.kamsa)');
      if (!username || !username.trim()) return;
      try {
        await putJSON(`${API}/devices/${d.id}/chown`, { strike: username.trim() });
        await refresh();
        setStatus(`Strike Updated to ${username.trim()}`, false);
      } catch (e) {
        setStatus(parseError(e), true);
      }
    };
    

    actionsTd.appendChild(allotBtn);
    actionsTd.appendChild(releaseBtn);
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

// --- helpers ---
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json().catch(() => ({})); // some endpoints return 204
}
async function putJSON(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json().catch(() => ({})); // handles empty response
}
function setStatus(msg, isError) {
  statusEl.textContent = msg || '';
  statusEl.className = isError ? 'error' : 'success';
}

function parseError(e) {
  try {
    const obj = JSON.parse(e.message);
    return obj.error || e.message;
  } catch {
    return e.message;
  }
}

refresh().catch(err => setStatus(parseError(err), true));
