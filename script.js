const menuButton = document.querySelector('.menu-toggle');
const nav = document.querySelector('.nav');

if (menuButton && nav) {
  menuButton.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('open');
    menuButton.setAttribute('aria-expanded', String(isOpen));
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

function updateEstimator() {
  if (!fleetUnits || !idleShare || !carryingCost || !fleetUnitsOut || !idleUnitsOut || !annualBurdenOut || !targetReductionOut) {
    return;
  }

  const totalUnits = Number(fleetUnits.value);
  const idlePercent = Number(idleShare.value) / 100;
  const monthlyCost = Number(carryingCost.value);
  const idleUnits = Math.round(totalUnits * idlePercent);
  const annualBurden = idleUnits * monthlyCost * 12;
  const targetReduction = Math.round(annualBurden * 0.2);

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

[fleetUnits, idleShare, carryingCost].forEach((input) => {
  input?.addEventListener('input', updateEstimator);
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
});

nextStory?.addEventListener('click', () => {
  storyIndex = (storyIndex + 1) % stories.length;
  renderStory();
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
  form.addEventListener('submit', (event) => {
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
    const name = data.get('name')?.toString().trim() || 'there';
    const priority = data.get('priority')?.toString() || 'fleet strategy';
    formNote.textContent = `Thanks, ${name}. We received your ${priority.toLowerCase()} request and will reach out shortly.`;
    form.reset();
    fields.forEach((field) => markInvalid(field, false));
    updateEstimator();
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
    window.location.href = `mailto:consulting@fleetadvisorygroup.com?subject=${subject}&body=${body}`;
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
  });
}
