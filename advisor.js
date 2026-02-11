async function loadDashboard() {
  const response = await fetch('/api/dashboard');
  if (!response.ok) {
    throw new Error('Failed to load dashboard');
  }
  return response.json();
}

function renderList(container, entries, mapper) {
  container.innerHTML = '';
  entries.forEach((entry) => {
    const li = document.createElement('li');
    li.textContent = mapper(entry);
    container.appendChild(li);
  });
}

function renderDashboard(data) {
  document.getElementById('metricLeads').textContent = String(data.totals.leads);
  document.getElementById('metricScore').textContent = String(data.totals.avgScore);
  document.getElementById('metricQueue').textContent = String(data.totals.pendingCrmSync);

  const statusEntries = Object.entries(data.statusCounts);
  renderList(document.getElementById('statusList'), statusEntries, ([status, count]) => `${status}: ${count}`);
  renderList(
    document.getElementById('priorityList'),
    data.topPriorities,
    (item) => `${item.priority}: ${item.count}`,
  );

  const rows = document.getElementById('leadRows');
  rows.innerHTML = '';
  data.recentLeads.forEach((lead) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${lead.name}</td>
      <td>${lead.email}</td>
      <td>${lead.priority}</td>
      <td>${lead.score ?? 0}</td>
      <td>${lead.grade ?? 'C'}</td>
      <td>${lead.status}</td>
    `;
    rows.appendChild(tr);
  });
}

async function refresh() {
  try {
    const data = await loadDashboard();
    renderDashboard(data);
  } catch {
    const note = document.getElementById('syncNote');
    note.textContent = 'Unable to load dashboard data.';
  }
}

const syncBtn = document.getElementById('syncBtn');
const syncNote = document.getElementById('syncNote');

if (syncBtn) {
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    try {
      const response = await fetch('/api/crm-sync/mock', { method: 'POST' });
      const data = await response.json();
      syncNote.textContent = `Mock CRM sync complete. Synced ${data.synced ?? 0} queued lead(s).`;
      await refresh();
    } catch {
      syncNote.textContent = 'Mock CRM sync failed.';
    } finally {
      syncBtn.disabled = false;
    }
  });
}

refresh();
