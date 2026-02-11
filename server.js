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
    const initial = { leads: [], events: [], estimatorSnapshots: [] };
    await fsp.writeFile(DB_FILE, JSON.stringify(initial, null, 2));
  }
}

async function readDb() {
  const raw = await fsp.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
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
      } catch (error) {
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

function validateLead(payload) {
  const name = normalizeText(payload.name);
  const email = normalizeText(payload.email);
  const fleetSize = normalizeText(payload.fleetSize);
  const priority = normalizeText(payload.priority);
  const message = normalizeText(payload.message);
  const website = normalizeText(payload.website);

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
      source: 'website',
      createdAt: new Date().toISOString(),
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

async function handleApi(req, res) {
  if (req.method === 'POST' && req.url === '/api/leads') {
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
    db.leads.push(checked.lead);
    await writeDb(db);

    return sendJson(res, 201, { ok: true, leadId: checked.lead.id });
  }

  if (req.method === 'POST' && req.url === '/api/events') {
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

  if (req.method === 'POST' && req.url === '/api/estimator-snapshot') {
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
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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
