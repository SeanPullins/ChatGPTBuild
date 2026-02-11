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
    const initial = { leads: [], events: [], estimatorSnapshots: [], crmQueue: [] };
    await fsp.writeFile(DB_FILE, JSON.stringify(initial, null, 2));
  }
}

async function readDb() {
  const raw = await fsp.readFile(DB_FILE, 'utf8');
  const db = JSON.parse(raw);
  db.crmQueue = Array.isArray(db.crmQueue) ? db.crmQueue : [];
  db.leads = Array.isArray(db.leads) ? db.leads : [];
  db.events = Array.isArray(db.events) ? db.events : [];
  db.estimatorSnapshots = Array.isArray(db.estimatorSnapshots) ? db.estimatorSnapshots : [];

  let changed = false
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

async function writeDb(next) {
  await fsp.writeFile(DB_FILE, JSON.stringify(next, null, 2));
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
      avgScore,
    },
    statusCounts,
    topPriorities,
    recentLeads: db.leads
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10),
  };
}

async function handleApi(req, res) {
  const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = fullUrl;

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
    const latestSnapshot = db.estimatorSnapshots
      .filter((s) => s.sessionId === checked.lead.sessionId)
      .slice(-1)[0];
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
    await writeDb(db);

    return sendJson(res, 201, { ok: true, leadId: checked.lead.id, score: checked.lead.score, grade: checked.lead.grade });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/leads/')) {
    const id = pathname.replace('/api/leads/', '');
    const db = await readDb();
    const lead = db.leads.find((item) => item.id === id);
    if (!lead) {
      return sendJson(res, 404, { error: 'Lead not found.' });
    }
    return sendJson(res, 200, { lead });
  }

  if (req.method === 'PATCH' && pathname.startsWith('/api/leads/')) {
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

    const db = await readDb();
    const lead = db.leads.find((item) => item.id === id);
    if (!lead) {
      return sendJson(res, 404, { error: 'Lead not found.' });
    }

    lead.status = status;
    lead.updatedAt = new Date().toISOString();
    await writeDb(db);

    return sendJson(res, 200, { ok: true, lead });
  }

  if (req.method === 'GET' && pathname === '/api/dashboard') {
    const db = await readDb();
    return sendJson(res, 200, dashboardSummary(db));
  }

  if (req.method === 'POST' && pathname === '/api/crm-sync/mock') {
    const db = await readDb();
    let synced = 0;
    const now = new Date().toISOString();

    for (const item of db.crmQueue) {
      if (!item.syncedAt) {
        item.syncedAt = now;
        synced += 1;
      }
    }

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

  sendJson(res, 404, { error: 'Not found' });
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
        'Access-Control-Allow-Headers': 'Content-Type',
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
