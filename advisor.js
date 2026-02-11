let selectedLeadId = null;
const tokenStorage = 'advisor_auth_token';

function currentToken() {
  return localStorage.getItem(tokenStorage) || '';
}

function authHeaders() {
  const token = currentToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...authHeaders(),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function activeFilters() {
  const status = document.getElementById('statusFilter')?.value || '';
  const grade = document.getElementById('gradeFilter')?.value || '';
  return { status, grade };
}

function withFilters(urlBase) {
  const filters = activeFilters();
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.grade) params.set('grade', filters.grade);
  const qs = params.toString();
  return qs ? `${urlBase}?${qs}` : urlBase;
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
  const [dashboard, funnel] = await Promise.all([
    getJson(withFilters('/api/dashboard')),
    getJson(withFilters('/api/analytics/funnel')),
  ]);
  return { dashboard, funnel };
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
  const { dashboard, funnel } = data;
  document.getElementById('metricLeads').textContent = String(dashboard.totals.leads);
  document.getElementById('metricScore').textContent = String(dashboard.totals.avgScore);
  document.getElementById('metricQueue').textContent = String(dashboard.totals.pendingCrmSync);
  document.getElementById('metricQualifiedRate').textContent = `${funnel.rates.qualifiedRate}%`;
  document.getElementById('metricProposalRate').textContent = `${funnel.rates.proposalRate}%`;
  document.getElementById('metricWinRate').textContent = `${funnel.rates.winRate}%`;

  const statusEntries = Object.entries(dashboard.statusCounts);
  renderList(document.getElementById('statusList'), statusEntries, ([status, count]) => `${status}: ${count}`);
  renderList(document.getElementById('priorityList'), dashboard.topPriorities, (item) => `${item.priority}: ${item.count}`);

  const rows = document.getElementById('leadRows');
  rows.innerHTML = '';

  dashboard.recentLeads.forEach((lead) => {
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
        <div class="dashboard-row" style="margin-bottom: 0.5rem;">
          <button id="copyDraftBtn" class="btn btn-secondary btn-sm" type="button">Copy Draft</button>
        </div>
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
    const copyDraftBtn = panel.querySelector('#copyDraftBtn');

    draftBtn.addEventListener('click', async () => {
      const draftData = await getJson('/api/outreach/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId: selectedLeadId }),
      });

      draftNote.textContent = `Draft created at ${new Date(draftData.draft.createdAt).toLocaleString()}`;
      draftOutput.textContent = `Subject: ${draftData.draft.subject}\n\n${draftData.draft.body}`;
    });

    copyDraftBtn.addEventListener('click', async () => {
      const text = draftOutput.textContent.trim();
      if (!text) {
        draftNote.textContent = 'Generate a draft first before copying.';
        return;
      }
      await navigator.clipboard.writeText(text);
      draftNote.textContent = 'Draft copied to clipboard.';
    });
  } catch (error) {
    panel.innerHTML = `<p class="note">Unable to load intelligence: ${error.message}</p>`;
  }
}

async function loginFlow() {
  const username = window.prompt('Advisor username', 'advisor');
  if (!username) return;
  const password = window.prompt('Advisor password', 'advisor123');
  if (!password) return;

  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username.trim(), password: password.trim() }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) {
    throw new Error(data.error || 'Login failed');
  }
  localStorage.setItem(tokenStorage, data.token);
}

async function logoutFlow() {
  const token = currentToken();
  if (token) {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  localStorage.removeItem(tokenStorage);
}

async function refresh() {
  const authState = document.getElementById('authState');
  try {
    const me = await getJson('/api/auth/me');
    authState.textContent = `Signed in as ${me.user.username} (${me.user.role}).`;
    const data = await loadDashboard();
    renderDashboard(data);
    await renderLeadIntelligence();
  } catch {
    authState.textContent = 'Not signed in.';
    const note = document.getElementById('syncNote');
    if (note) note.textContent = 'Please sign in to load advisor data.';
  }
}

const syncBtn = document.getElementById('syncBtn');
const syncNote = document.getElementById('syncNote');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const applyFiltersBtn = document.getElementById('applyFiltersBtn');

loginBtn?.addEventListener('click', async () => {
  try {
    await loginFlow();
    await refresh();
  } catch (error) {
    const note = document.getElementById('syncNote');
    if (note) note.textContent = error.message;
  }
});

logoutBtn?.addEventListener('click', async () => {
  await logoutFlow();
  selectedLeadId = null;
  await refresh();
});

applyFiltersBtn?.addEventListener('click', async () => {
  await refresh();
});

syncBtn?.addEventListener('click', async () => {
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

refresh();
