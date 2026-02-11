const sessionKey = 'fleet_session_id';
let sessionId = localStorage.getItem(sessionKey);
if (!sessionId) {
  sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(sessionKey, sessionId);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response;
}

function trackEvent(eventType, payload = {}) {
  postJson('/api/events', {
    eventType,
    sessionId,
    page: window.location.pathname,
    payload,
  }).catch(() => {});
}

const menuButton = document.querySelector('.menu-toggle');
const nav = document.querySelector('.nav');

if (menuButton && nav) {
  menuButton.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('open');
    menuButton.setAttribute('aria-expanded', String(isOpen));
    trackEvent('menu_toggled', { open: isOpen });
  });
}

const messageField = document.getElementById('messageField');
const intentButtons = document.querySelectorAll('[data-intent]');

intentButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (!messageField) return;
    const intent = button.getAttribute('data-intent') || '';
    messageField.value = intent;
    messageField.focus();
    const contactSection = document.getElementById('contact');
    contactSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    trackEvent('intent_chip_clicked', { intent });
  });
});

const fleetUnits = document.getElementById('fleetUnits');
const idleShare = document.getElementById('idleShare');
const carryingCost = document.getElementById('carryingCost');
const fleetUnitsOut = document.getElementById('fleetUnitsOut');
const idleUnitsOut = document.getElementById('idleUnitsOut');
const annualBurdenOut = document.getElementById('annualBurdenOut');
const targetReductionOut = document.getElementById('targetReductionOut');
const fleetUnitsLabel = document.getElementById('fleetUnitsLabel');
const idleShareLabel = document.getElementById('idleShareLabel');
const carryingCostLabel = document.getElementById('carryingCostLabel');
const savingsBadge = document.getElementById('savingsBadge');

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function currentEstimator() {
  const totalUnits = Number(fleetUnits?.value || 0);
  const idlePercent = Number(idleShare?.value || 0) / 100;
  const monthlyCost = Number(carryingCost?.value || 0);
  const idleUnits = Math.round(totalUnits * idlePercent);
  const annualBurden = idleUnits * monthlyCost * 12;
  const targetReduction = Math.round(annualBurden * 0.2);
  return { totalUnits, idlePercent, monthlyCost, idleUnits, annualBurden, targetReduction };
}

function updateEstimator() {
  if (!fleetUnits || !idleShare || !carryingCost || !fleetUnitsOut || !idleUnitsOut || !annualBurdenOut || !targetReductionOut) {
    return;
  }

  const { totalUnits, idlePercent, monthlyCost, idleUnits, annualBurden, targetReduction } = currentEstimator();

  fleetUnitsOut.textContent = String(totalUnits);
  idleUnitsOut.textContent = String(idleUnits);
  annualBurdenOut.textContent = formatCurrency(annualBurden);
  targetReductionOut.textContent = formatCurrency(targetReduction);

  if (fleetUnitsLabel) fleetUnitsLabel.textContent = String(totalUnits);
  if (idleShareLabel) idleShareLabel.textContent = `${Math.round(idlePercent * 100)}%`;
  if (carryingCostLabel) carryingCostLabel.textContent = formatCurrency(monthlyCost);

  if (savingsBadge) {
    savingsBadge.textContent =
      targetReduction > 100000
        ? 'High-impact opportunity: optimization target exceeds $100K/yr.'
        : 'Moderate-impact opportunity: optimization target identified.';
  }
}

let estimatorTimer;
[fleetUnits, idleShare, carryingCost].forEach((input) => {
  input?.addEventListener('input', () => {
    updateEstimator();
    clearTimeout(estimatorTimer);
    estimatorTimer = setTimeout(() => {
      const est = currentEstimator();
      postJson('/api/estimator-snapshot', {
        sessionId,
        totalUnits: est.totalUnits,
        idleShare: Math.round(est.idlePercent * 100),
        carryingCost: est.monthlyCost,
        annualBurden: est.annualBurden,
      }).catch(() => {});
      trackEvent('estimator_updated', { totalUnits: est.totalUnits, idleShare: Math.round(est.idlePercent * 100) });
    }, 500);
  });
});
updateEstimator();

const tabButtons = document.querySelectorAll('.tab-btn');
const scenarioPanels = document.querySelectorAll('.scenario-panel');

function setScenario(name) {
  tabButtons.forEach((button) => {
    const active = button.dataset.scenario === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });

  scenarioPanels.forEach((panel) => {
    const active = panel.id === `${name}Panel`;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
}

tabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const name = button.dataset.scenario || 'before';
    setScenario(name);
    trackEvent('scenario_changed', { scenario: name });
  });
});

const stories = [
  {
    quote: '“We cut idle units by 17% in two quarters and redirected capital into better-fit equipment.”',
    meta: 'Regional Service Fleet · 140 units',
  },
  {
    quote: '“The acquisition short list prevented overbuying and gave finance a cleaner ROI narrative.”',
    meta: 'Industrial Contractor · 92 units',
  },
  {
    quote: '“Our divestment sequence improved recovery value and reduced disposal delays dramatically.”',
    meta: 'Distribution Operator · 210 units',
  },
];

let storyIndex = 0;
const storyQuote = document.getElementById('storyQuote');
const storyMeta = document.getElementById('storyMeta');
const prevStory = document.getElementById('prevStory');
const nextStory = document.getElementById('nextStory');

function renderStory() {
  if (!storyQuote || !storyMeta) return;
  const current = stories[storyIndex];
  storyQuote.textContent = current.quote;
  storyMeta.innerHTML = `<strong>${current.meta.split(' · ')[0]}</strong> · ${current.meta.split(' · ')[1]}`;
}

prevStory?.addEventListener('click', () => {
  storyIndex = (storyIndex - 1 + stories.length) % stories.length;
  renderStory();
  trackEvent('story_navigated', { direction: 'prev', index: storyIndex });
});

nextStory?.addEventListener('click', () => {
  storyIndex = (storyIndex + 1) % stories.length;
  renderStory();
  trackEvent('story_navigated', { direction: 'next', index: storyIndex });
});

setInterval(() => {
  storyIndex = (storyIndex + 1) % stories.length;
  renderStory();
}, 6000);
renderStory();

const form = document.querySelector('.contact-form');
const formNote = document.querySelector('.form-note');

function markInvalid(input, invalid) {
  input.classList.toggle('invalid', invalid);
}

if (form && formNote) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const nameInput = form.querySelector('input[name="name"]');
    const emailInput = form.querySelector('input[name="email"]');
    const fleetSizeInput = form.querySelector('input[name="fleetSize"]');
    const msgInput = form.querySelector('textarea[name="message"]');

    if (!nameInput || !emailInput || !fleetSizeInput || !msgInput) {
      return;
    }

    const fields = [nameInput, emailInput, fleetSizeInput, msgInput];
    let hasInvalid = false;

    fields.forEach((field) => {
      const empty = !field.value.trim();
      markInvalid(field, empty);
      if (empty) hasInvalid = true;
    });

    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.value.trim());
    markInvalid(emailInput, !emailValid);
    if (!emailValid) hasInvalid = true;

    if (hasInvalid) {
      formNote.textContent = 'Please complete all required fields with a valid work email.';
      return;
    }

    const data = new FormData(form);
    const payload = {
      name: data.get('name')?.toString().trim(),
      email: data.get('email')?.toString().trim(),
      fleetSize: data.get('fleetSize')?.toString().trim(),
      priority: data.get('priority')?.toString().trim(),
      message: data.get('message')?.toString().trim(),
      website: data.get('website')?.toString().trim(),
      sessionId,
    };

    try {
      const response = await postJson('/api/leads', payload);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unable to submit request.' }));
        formNote.textContent = errorData.error || 'Unable to submit request.';
        trackEvent('lead_submit_failed', { status: response.status });
        return;
      }

      const name = payload.name || 'there';
      const priority = payload.priority || 'fleet strategy';
      formNote.textContent = `Thanks, ${name}. We received your ${priority.toLowerCase()} request and will reach out shortly.`;
      form.reset();
      fields.forEach((field) => markInvalid(field, false));
      updateEstimator();
      trackEvent('lead_submitted', { priority });
    } catch {
      formNote.textContent = 'Network issue: please retry or use Open Email Draft.';
      trackEvent('lead_submit_failed', { status: 'network_error' });
    }
  });
}

const emailDraftBtn = document.getElementById('emailDraftBtn');
if (emailDraftBtn && form) {
  emailDraftBtn.addEventListener('click', () => {
    const name = form.querySelector('input[name="name"]')?.value.trim() || 'Team';
    const priority = form.querySelector('select[name="priority"]')?.value || 'Fleet review';
    const fleetSize = form.querySelector('input[name="fleetSize"]')?.value.trim() || 'Not specified';
    const subject = encodeURIComponent(`Fleet Consulting Inquiry: ${priority}`);
    const body = encodeURIComponent(`Hello Fleet Advisory Group,%0D%0A%0D%0AName: ${name}%0D%0AFleet size: ${fleetSize}%0D%0APriority: ${priority}%0D%0A%0D%0AI would like to discuss next steps.%0D%0A`);
    trackEvent('email_draft_opened', { priority });
    window.location.href = `mailto:consulting@fleetadvisorygroup.com?subject=${subject}&body=${body}`;
  });
}

const form = document.querySelector('.contact-form');
const formNote = document.querySelector('.form-note');

if (form && formNote) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const name = data.get('name')?.toString().trim() || 'there';
    formNote.textContent = `Thanks, ${name}. We received your request and will reach out shortly.`;
    form.reset();
  });
}

const year = document.getElementById('year');
if (year) {
  year.textContent = String(new Date().getFullYear());
}

const backToTop = document.getElementById('backToTop');
const progress = document.getElementById('scrollProgress');
const stickyCta = document.getElementById('stickyCta');
const navLinks = document.querySelectorAll('.nav a[href^="#"]');
const sections = document.querySelectorAll('main section[id]');

function handleScrollEffects() {
  const scrollTop = window.scrollY;
  const docHeight = document.documentElement.scrollHeight - window.innerHeight;
  const progressPct = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;

  if (progress) {
    progress.style.width = `${Math.min(100, Math.max(0, progressPct))}%`;
  }

  if (backToTop) {
    backToTop.classList.toggle('visible', scrollTop > 420);
  }

  if (stickyCta) {
    const show = scrollTop > 520;
    stickyCta.hidden = !show;
  }

  let current = '';
  sections.forEach((section) => {
    const top = section.offsetTop - 120;
    if (scrollTop >= top) current = section.getAttribute('id') || '';
  });

  navLinks.forEach((link) => {
    const href = link.getAttribute('href') || '';
    link.classList.toggle('active', href === `#${current}`);
  });
}

window.addEventListener('scroll', handleScrollEffects, { passive: true });
handleScrollEffects();

if (backToTop) {
  backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    trackEvent('back_to_top_clicked');
  });
}

trackEvent('page_view');
