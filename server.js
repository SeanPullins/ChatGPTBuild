const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 4173);
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_BODY_BYTES = 1024 * 1024;
const rateLimiter = new Map();

const LEAD_STATUSES = new Set(['new', 'qualified', 'contacted', 'proposal_sent', 'won', 'lost']);
const ADVISOR_API_KEY = process.env.ADVISOR_API_KEY || 'advisor-dev-key';
const AUTH_TOKEN_TTL_MS = 1000 * 60 * 60 * 8;
const advisorSessions = new Map();
const ADVISOR_USERS = [
  { id: 'u1', username: process.env.ADVISOR_USERNAME || 'advisor', password: process.env.ADVISOR_PASSWORD || 'advisor123', role: 'advisor' },
  { id: 'u2', username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD || 'admin123', role: 'admin' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

async function ensureDb() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      leads: [],
      events: [],
      estimatorSnapshots: [],
      crmQueue: [],
      outreachDrafts: [],
      auditEvents: [],
    };
    await fsp.writeFile(DB_FILE, JSON.stringify(initial, null, 2));
  }
}

async function writeDb(next) {
  await fsp.writeFile(DB_FILE, JSON.stringify(next, null, 2));
}

async function readDb() {
  const raw = await fsp.readFile(DB_FILE, 'utf8');
  const db = JSON.parse(raw);
  db.crmQueue = Array.isArray(db.crmQueue) ? db.crmQueue : [];
  db.leads = Array.isArray(db.leads) ? db.leads : [];
  db.events = Array.isArray(db.events) ? db.events : [];
  db.estimatorSnapshots = Array.isArray(db.estimatorSnapshots) ? db.estimatorSnapshots : [];
  db.outreachDrafts = Array.isArray(db.outreachDrafts) ? db.outreachDrafts : [];
  db.auditEvents = Array.isArray(db.auditEvents) ? db.auditEvents : [];

  let changed = false;
  for (const lead of db.leads) {
    if (!lead.status || !LEAD_STATUSES.has(lead.status)) {
      lead.status = 'new';
      changed = true;
    }
    if (typeof lead.score !== 'number') {
      lead.score = 0;
      changed = true;
    }
    if (!lead.grade) {
      lead.grade = 'C';
      changed = true;
    }
    if (!Array.isArray(lead.scoreReasons)) {
      lead.scoreReasons = [];
      changed = true;
    }
    if (!lead.updatedAt) {
      lead.updatedAt = lead.createdAt || new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    await writeDb(db);
  }

  return db;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function getIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(req, key, limit, windowMs) {
  const ip = getIp(req);
  const bucketKey = `${ip}:${key}`;
  const now = Date.now();
  const bucket = rateLimiter.get(bucketKey) || [];
  const recent = bucket.filter((ts) => now - ts < windowMs);
  if (recent.length >= limit) {
    rateLimiter.set(bucketKey, recent);
    return false;
  }
  recent.push(now);
  rateLimiter.set(bucketKey, recent);
  return true;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseFleetSize(raw) {
  const numeric = Number(String(raw || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(numeric) ? numeric : 0;
}

function extractAdvisorKey(req) {
  const headerKey = req.headers['x-advisor-key'];
  if (typeof headerKey === 'string' && headerKey.trim()) {
    return headerKey.trim();
  }
  return '';
}

function extractBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.replace('Bearer ', '').trim();
  }
  return '';
}

function createSession(user) {
  const token = crypto.randomUUID();
  const now = Date.now();
  advisorSessions.set(token, {
    token,
    userId: user.id,
    username: user.username,
    role: user.role,
    createdAt: now,
    expiresAt: now + AUTH_TOKEN_TTL_MS,
  });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const session = advisorSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    advisorSessions.delete(token);
    return null;
  }
  return session;
}

function requireAdvisorAuth(req, res) {
  const providedKey = extractAdvisorKey(req);
  if (providedKey && providedKey === ADVISOR_API_KEY) {
    return { ok: true, authType: 'api_key', role: 'admin', username: 'api-key', userId: 'api-key' };
  }

  const token = extractBearerToken(req);
  const session = getSession(token);
  if (session) {
    return {
      ok: true,
      authType: 'session',
      role: session.role,
      username: session.username,
      userId: session.userId,
      token,
    };
  }

  sendJson(res, 401, { error: 'Unauthorized advisor request.' });
  return { ok: false };
}

function requireRole(res, auth, roles) {
  if (!roles.includes(auth.role)) {
    sendJson(res, 403, { error: 'Insufficient permissions.' });
    return false;
  }
  return true;
}

function scoreLead(lead, estimatorSnapshot) {
  let score = 0;
  const reasons = [];

  if (lead.priority === 'Need both acquisition and sell-off') {
    score += 20;
    reasons.push('Combined acquisition + divestment priority');
  } else if (lead.priority === 'Acquire units' || lead.priority === 'Sell off units') {
    score += 10;
    reasons.push('Single-track priority selected');
  }

  const fleet = parseFleetSize(lead.fleetSize);
  if (fleet >= 150) {
    score += 15;
    reasons.push('Fleet size >= 150');
  } else if (fleet >= 80) {
    score += 8;
    reasons.push('Fleet size >= 80');
  }

  const burden = Number(estimatorSnapshot?.annualBurden || 0);
  if (burden >= 500000) {
    score += 20;
    reasons.push('High annual burden >= $500K');
  } else if (burden >= 200000) {
    score += 12;
    reasons.push('Annual burden >= $200K');
  }

  const msg = lead.message.toLowerCase();
  if (msg.includes('urgent') || msg.includes('asap') || msg.includes('immediately')) {
    score += 6;
    reasons.push('Urgency signal in message');
  }

  const grade = score >= 40 ? 'A' : score >= 25 ? 'B' : 'C';
  return { score, grade, reasons };
}

function recommendationForLead(lead) {
  const recommendations = [];
  if (lead.priority === 'Need both acquisition and sell-off') {
    recommendations.push('Run a combined keep/replace/divest workshop in week 1.');
    recommendations.push('Build a phased acquisition + liquidation schedule over 90 days.');
  }
  if (lead.priority === 'Acquire units') {
    recommendations.push('Prioritize specification alignment and total-cost vendor shortlist.');
  }
  if (lead.priority === 'Sell off units') {
    recommendations.push('Start with high-carry-cost and low-utilization units for sell-off.');
  }

  const fleet = parseFleetSize(lead.fleetSize);
  if (fleet >= 150) {
    recommendations.push('Create region-based fleet segmentation to speed decision cycles.');
  }

  if (lead.grade === 'A') {
    recommendations.push('Route to senior advisor and schedule discovery call within 24 hours.');
  } else if (lead.grade === 'B') {
    recommendations.push('Schedule advisor call within 72 hours and send pre-call questionnaire.');
  } else {
    recommendations.push('Assign nurture sequence with estimator follow-up and case examples.');
  }

  const nextBestAction = lead.grade === 'A' ? 'Immediate senior discovery call' : 'Advisor qualification call';
  return { nextBestAction, recommendations };
}

function createOutreachDraft(lead, recommendation) {
  const subject = `Fleet Strategy Next Steps for ${lead.name}`;
  const body = [
    `Hi ${lead.name},`,
    '',
    'Thanks for reaching out regarding your fleet strategy priorities.',
    `Based on your request (${lead.priority}) and profile, our suggested first move is: ${recommendation.nextBestAction}.`,
    '',
    'Proposed immediate focus areas:',
    ...recommendation.recommendations.map((item, idx) => `${idx + 1}. ${item}`),
    '',
    'Would you be available for a 30-minute strategy call this week?',
    '',
    'Best,',
    'Fleet Advisory Group',
  ].join('\n');

  return { subject, body };
}

function appendAudit(db, actor, action, targetType, targetId, details = {}) {
  db.auditEvents.push({
    id: crypto.randomUUID(),
    actor,
    action,
    targetType,
    targetId,
    details,
    createdAt: new Date().toISOString(),
  });
}

function validateLead(payload) {
  const name = normalizeText(payload.name);
  const email = normalizeText(payload.email);
  const fleetSize = normalizeText(payload.fleetSize);
  const priority = normalizeText(payload.priority);
  const message = normalizeText(payload.message);
  const website = normalizeText(payload.website);
  const sessionId = normalizeText(payload.sessionId) || 'anonymous';

  if (website) {
    return { ok: false, status: 400, error: 'Spam detected.' };
  }
  if (!name || !email || !fleetSize || !message || !priority) {
    return { ok: false, status: 400, error: 'Missing required fields.' };
  }
  if (!validEmail(email)) {
    return { ok: false, status: 400, error: 'Invalid email address.' };
  }

  return {
    ok: true,
    lead: {
      id: crypto.randomUUID(),
      name,
      email: email.toLowerCase(),
      fleetSize,
      priority,
      message,
      sessionId,
      source: 'website',
      status: 'new',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

function validateEvent(payload) {
  const eventType = normalizeText(payload.eventType);
  if (!eventType) {
    return { ok: false, error: 'eventType is required' };
  }
  return {
    ok: true,
    event: {
      id: crypto.randomUUID(),
      eventType,
      sessionId: normalizeText(payload.sessionId) || 'anonymous',
      page: normalizeText(payload.page) || '/',
      payload: payload.payload && typeof payload.payload === 'object' ? payload.payload : {},
      createdAt: new Date().toISOString(),
    },
  };
}

function dashboardSummary(db) {
  const statusCounts = {};
  for (const status of LEAD_STATUSES) {
    statusCounts[status] = 0;
  }

  let totalScore = 0;
  const priorityCounts = {};
  for (const lead of db.leads) {
    statusCounts[lead.status] = (statusCounts[lead.status] || 0) + 1;
    totalScore += Number(lead.score || 0);
    priorityCounts[lead.priority] = (priorityCounts[lead.priority] || 0) + 1;
  }

  const avgScore = db.leads.length ? Number((totalScore / db.leads.length).toFixed(2)) : 0;
  const topPriorities = Object.entries(priorityCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([priority, count]) => ({ priority, count }));

  return {
    totals: {
      leads: db.leads.length,
      events: db.events.length,
      estimatorSnapshots: db.estimatorSnapshots.length,
      pendingCrmSync: db.crmQueue.filter((item) => !item.syncedAt).length,
      outreachDrafts: db.outreachDrafts.length,
      avgScore,
    },
    statusCounts,
    topPriorities,
    recentLeads: db.leads
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 12),
  };
}

function funnelAnalytics(db) {
  const counts = {
    new: 0,
    qualified: 0,
    contacted: 0,
    proposal_sent: 0,
    won: 0,
    lost: 0,
  };

  db.leads.forEach((lead) => {
    if (counts[lead.status] !== undefined) {
      counts[lead.status] += 1;
    }
  });

  const base = db.leads.length || 1;
  const rates = {
    qualifiedRate: Number(((counts.qualified / base) * 100).toFixed(2)),
    contactedRate: Number(((counts.contacted / base) * 100).toFixed(2)),
    proposalRate: Number(((counts.proposal_sent / base) * 100).toFixed(2)),
    winRate: Number(((counts.won / base) * 100).toFixed(2)),
  };

  return { counts, rates, total: db.leads.length };
}

async function handleApi(req, res) {
  const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = fullUrl;

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    if (!checkRateLimit(req, 'login', 10, 60_000)) {
      return sendJson(res, 429, { error: 'Too many login attempts.' });
    }

    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }

    const username = normalizeText(payload.username);
    const password = normalizeText(payload.password);
    const user = ADVISOR_USERS.find((u) => u.username === username && u.password === password);
    if (!user) {
      return sendJson(res, 401, { error: 'Invalid credentials.' });
    }

    const token = createSession(user);
    return sendJson(res, 200, {
      ok: true,
      token,
      user: { id: user.id, username: user.username, role: user.role },
      expiresInMs: AUTH_TOKEN_TTL_MS,
    });
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const auth = requireAdvisorAuth(req, res);
    if (!auth.ok) return;
    return sendJson(res, 200, {
      ok: true,
      user: { id: auth.userId, username: auth.username, role: auth.role, authType: auth.authType },
    });
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const token = extractBearerToken(req);
    if (token) {
      advisorSessions.delete(token);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/leads') {
    if (!checkRateLimit(req, 'leads', 6, 60_000)) {
      return sendJson(res, 429, { error: 'Too many lead submissions. Please try again shortly.' });
    }

    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }

    const checked = validateLead(payload);
    if (!checked.ok) {
      return sendJson(res, checked.status, { error: checked.error });
    }

    const db = await readDb();
    const latestSnapshot = db.estimatorSnapshots.filter((s) => s.sessionId === checked.lead.sessionId).slice(-1)[0];
    const scored = scoreLead(checked.lead, latestSnapshot);
    checked.lead.score = scored.score;
    checked.lead.grade = scored.grade;
    checked.lead.scoreReasons = scored.reasons;

    db.leads.push(checked.lead);
    db.crmQueue.push({
      id: crypto.randomUUID(),
      leadId: checked.lead.id,
      createdAt: new Date().toISOString(),
      syncedAt: null,
      payload: {
        name: checked.lead.name,
        email: checked.lead.email,
        priority: checked.lead.priority,
        score: checked.lead.score,
        grade: checked.lead.grade,
      },
    });
    appendAudit(db, { type: 'system', username: 'public-form' }, 'lead.created', 'lead', checked.lead.id, {
      priority: checked.lead.priority,
      grade: checked.lead.grade,
    });
    await writeDb(db);

    return sendJson(res, 201, {
      ok: true,
      leadId: checked.lead.id,
      score: checked.lead.score,
      grade: checked.lead.grade,
    });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/leads/')) {
    const auth = requireAdvisorAuth(req, res);
    if (!auth.ok) return;
    const id = pathname.replace('/api/leads/', '');
    const db = await readDb();
    const lead = db.leads.find((item) => item.id === id);
    if (!lead) {
      return sendJson(res, 404, { error: 'Lead not found.' });
    }
    return sendJson(res, 200, { lead });
  }

  if (req.method === 'PATCH' && pathname.startsWith('/api/leads/')) {
    const auth = requireAdvisorAuth(req, res);
    if (!auth.ok) return;

    const parts = pathname.split('/').filter(Boolean);
    if (parts.length !== 4 || parts[3] !== 'status') {
      return sendJson(res, 404, { error: 'Not found' });
    }

    const id = parts[2];
    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }

    const status = normalizeText(payload.status);
    if (!LEAD_STATUSES.has(status)) {
      return sendJson(res, 400, { error: 'Invalid status value.' });
    }

    if ((status === 'won' || status === 'lost' || status === 'proposal_sent') && !requireRole(res, auth, ['admin'])) {
      return;
    }

    const db = await readDb();
    const lead = db.leads.find((item) => item.id === id);
    if (!lead) {
      return sendJson(res, 404, { error: 'Lead not found.' });
    }

    const oldStatus = lead.status;
    lead.status = status;
    lead.updatedAt = new Date().toISOString();
    appendAudit(db, { type: 'user', username: auth.username, role: auth.role }, 'lead.status_changed', 'lead', id, {
      from: oldStatus,
      to: status,
    });
    await writeDb(db);

    return sendJson(res, 200, { ok: true, lead });
  }

  if (req.method === 'GET' && pathname === '/api/dashboard') {
    const auth = requireAdvisorAuth(req, res);
    if (!auth.ok) return;
    const statusFilter = normalizeText(fullUrl.searchParams.get('status'));
    const gradeFilter = normalizeText(fullUrl.searchParams.get('grade')).toUpperCase();
    const db = await readDb();
    const filteredDb = { ...db };
    filteredDb.leads = db.leads.filter((lead) => {
      const statusOk = !statusFilter || lead.status === statusFilter;
      const gradeOk = !gradeFilter || lead.grade === gradeFilter;
      return statusOk && gradeOk;
    });
    return sendJson(res, 200, dashboardSummary(filteredDb));
  }

  if (req.method === 'GET' && pathname.startsWith('/api/recommendations/')) {
    const auth = requireAdvisorAuth(req, res);
    if (!auth.ok) return;
    const leadId = pathname.replace('/api/recommendations/', '');
    const db = await readDb();
    const lead = db.leads.find((item) => item.id === leadId);
    if (!lead) {
      return sendJson(res, 404, { error: 'Lead not found.' });
    }
    const recommendation = recommendationForLead(lead);
    return sendJson(res, 200, { leadId, recommendation });
  }

  if (req.method === 'POST' && pathname === '/api/outreach/draft') {
    const auth = requireAdvisorAuth(req, res);
    if (!auth.ok) return;
    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }

    const leadId = normalizeText(payload.leadId);
    if (!leadId) {
      return sendJson(res, 400, { error: 'leadId is required' });
    }

    const db = await readDb();
    const lead = db.leads.find((item) => item.id === leadId);
    if (!lead) {
      return sendJson(res, 404, { error: 'Lead not found.' });
    }

    const recommendation = recommendationForLead(lead);
    const draft = createOutreachDraft(lead, recommendation);
    const saved = {
      id: crypto.randomUUID(),
      leadId,
      subject: draft.subject,
      body: draft.body,
      createdAt: new Date().toISOString(),
    };

    db.outreachDrafts.push(saved);
    appendAudit(db, { type: 'user', username: auth.username, role: auth.role }, 'outreach.draft_created', 'lead', leadId, {
      draftId: saved.id,
    });
    await writeDb(db);
    return sendJson(res, 201, { ok: true, draft: saved });
  }

  if (req.method === 'GET' && pathname === '/api/analytics/funnel') {
    const auth = requireAdvisorAuth(req, res);
    if (!auth.ok) return;
    const statusFilter = normalizeText(fullUrl.searchParams.get('status'));
    const gradeFilter = normalizeText(fullUrl.searchParams.get('grade')).toUpperCase();
    const db = await readDb();
    const filteredDb = { ...db };
    filteredDb.leads = db.leads.filter((lead) => {
      const statusOk = !statusFilter || lead.status === statusFilter;
      const gradeOk = !gradeFilter || lead.grade === gradeFilter;
      return statusOk && gradeOk;
    });
    return sendJson(res, 200, funnelAnalytics(filteredDb));
  }

  if (req.method === 'GET' && pathname === '/api/audit') {
    const auth = requireAdvisorAuth(req, res);
    if (!auth.ok) return;
    const limit = Math.min(Number(fullUrl.searchParams.get('limit') || 25), 100);
    const db = await readDb();
    const events = db.auditEvents
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit);
    return sendJson(res, 200, { events });
  }

  if (req.method === 'POST' && pathname === '/api/crm-sync/mock') {
    const auth = requireAdvisorAuth(req, res);
    if (!auth.ok) return;
    if (!requireRole(res, auth, ['admin'])) return;

    const db = await readDb();
    let synced = 0;
    const now = new Date().toISOString();
    for (const item of db.crmQueue) {
      if (!item.syncedAt) {
        item.syncedAt = now;
        synced += 1;
      }
    }
    appendAudit(db, { type: 'user', username: auth.username, role: auth.role }, 'crm.sync_mock', 'crmQueue', 'all', { synced });
    await writeDb(db);
    return sendJson(res, 200, { ok: true, synced });
  }

  if (req.method === 'POST' && pathname === '/api/events') {
    if (!checkRateLimit(req, 'events', 120, 60_000)) {
      return sendJson(res, 429, { error: 'Too many events.' });
    }

    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }

    const checked = validateEvent(payload);
    if (!checked.ok) {
      return sendJson(res, 400, { error: checked.error });
    }

    const db = await readDb();
    db.events.push(checked.event);
    await writeDb(db);

    return sendJson(res, 202, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/estimator-snapshot') {
    if (!checkRateLimit(req, 'snapshot', 60, 60_000)) {
      return sendJson(res, 429, { error: 'Too many requests.' });
    }

    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }

    const db = await readDb();
    db.estimatorSnapshots.push({
      id: crypto.randomUUID(),
      sessionId: normalizeText(payload.sessionId) || 'anonymous',
      totalUnits: Number(payload.totalUnits) || 0,
      idleShare: Number(payload.idleShare) || 0,
      carryingCost: Number(payload.carryingCost) || 0,
      annualBurden: Number(payload.annualBurden) || 0,
      createdAt: new Date().toISOString(),
    });
    await writeDb(db);

    return sendJson(res, 202, { ok: true });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function safePath(urlPath) {
  const clean = urlPath.split('?')[0].replace(/^\/+/, '');
  const target = clean || 'index.html';
  const resolved = path.join(ROOT, target);
  if (!resolved.startsWith(ROOT)) {
    return null;
  }
  return resolved;
}

async function handleStatic(req, res) {
  const filepath = safePath(req.url || '/');
  if (!filepath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const stat = await fsp.stat(filepath);
    if (stat.isDirectory()) {
      return handleStatic({ ...req, url: '/index.html' }, res);
    }
    const ext = path.extname(filepath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(filepath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

async function start() {
  await ensureDb();

  const server = http.createServer(async (req, res) => {
    if (!req.url || !req.method) {
      return sendJson(res, 400, { error: 'Bad request' });
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-advisor-key',
      });
      return res.end();
    }

    if (req.url.startsWith('/api/')) {
      return handleApi(req, res);
    }

    return handleStatic(req, res);
  });

  server.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
