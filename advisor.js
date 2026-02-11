let selectedLeadId = null;

async function getJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function renderList(container, entries, mapper) {
  container.innerHTML = '';
  entries.forEach((entry) => {
    const li = document.createElement('li');
    li.textContent = mapper(entry);
    container.appendChild(li);
  });
}

async function loadDashboard() {
  return getJson('/api/dashboard');
}

function createStatusSelect(lead) {
  const select = document.createElement('select');
  const statuses = ['new', 'qualified', 'contacted', 'proposal_sent', 'won', 'lost'];
  statuses.forEach((status) => {
    const option = document.createElement('option');
    option.value = status;
    option.textContent = status;
    option.selected = lead.status === status;
    select.appendChild(option);
  });

  select.addEventListener('change', async () => {
    await getJson(`/api/leads/${lead.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: select.value }),
    });
    await refresh();
  });

  return select;
}

function renderDashboard(data) {
  document.getElementById('metricLeads').textContent = String(data.totals.leads);
  document.getElementById('metricScore').textContent = String(data.totals.avgScore);
  document.getElementById('metricQueue').textContent = String(data.totals.pendingCrmSync);

  const statusEntries = Object.entries(data.statusCounts);
  renderList(document.getElementById('statusList'), statusEntries, ([status, count]) => `${status}: ${count}`);
  renderList(document.getElementById('priorityList'), data.topPriorities, (item) => `${item.priority}: ${item.count}`);

  const rows = document.getElementById('leadRows');
  rows.innerHTML = '';

  data.recentLeads.forEach((lead) => {
    const tr = document.createElement('tr');

    const actionBtn = document.createElement('button');
    actionBtn.className = 'btn btn-sm';
    actionBtn.textContent = 'View';
    actionBtn.addEventListener('click', () => {
      selectedLeadId = lead.id;
      renderLeadIntelligence();
    });

    tr.innerHTML = `
      <td>${lead.name}</td>
      <td>${lead.email}</td>
      <td>${lead.priority}</td>
      <td>${lead.score ?? 0}</td>
      <td>${lead.grade ?? 'C'}</td>
      <td></td>
      <td></td>
    `;

    tr.children[5].appendChild(createStatusSelect(lead));
    tr.children[6].appendChild(actionBtn);
    rows.appendChild(tr);
  });
}

async function renderLeadIntelligence() {
  const panel = document.getElementById('intelPanel');
  if (!selectedLeadId) {
    panel.innerHTML = '<p class="note">No lead selected.</p>';
    return;
  }

  try {
    const leadData = await getJson(`/api/leads/${selectedLeadId}`);
    const recData = await getJson(`/api/recommendations/${selectedLeadId}`);

    panel.innerHTML = `
      <div class="intel-block">
        <h3>${leadData.lead.name} (${leadData.lead.grade})</h3>
        <p><strong>Priority:</strong> ${leadData.lead.priority}</p>
        <p><strong>Score:</strong> ${leadData.lead.score}</p>
        <p><strong>Next Best Action:</strong> ${recData.recommendation.nextBestAction}</p>
        <ul id="recommendationList"></ul>
        <button id="draftBtn" class="btn btn-sm" type="button">Generate Outreach Draft</button>
      </div>
      <div class="intel-block">
        <h3>Outreach Draft</h3>
        <p class="note" id="draftNote">No draft generated yet.</p>
        <pre id="draftOutput" class="draft-output"></pre>
      </div>
    `;

    const list = panel.querySelector('#recommendationList');
    recData.recommendation.recommendations.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    });

    const draftBtn = panel.querySelector('#draftBtn');
    const draftOutput = panel.querySelector('#draftOutput');
    const draftNote = panel.querySelector('#draftNote');

    draftBtn.addEventListener('click', async () => {
      const draftData = await getJson('/api/outreach/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId: selectedLeadId }),
      });

      draftNote.textContent = `Draft created at ${new Date(draftData.draft.createdAt).toLocaleString()}`;
      draftOutput.textContent = `Subject: ${draftData.draft.subject}\n\n${draftData.draft.body}`;
    });
  } catch (error) {
    panel.innerHTML = `<p class="note">Unable to load intelligence: ${error.message}</p>`;
  }
}

async function refresh() {
  try {
    const data = await loadDashboard();
    renderDashboard(data);
    await renderLeadIntelligence();
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
      const data = await getJson('/api/crm-sync/mock', { method: 'POST' });
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
