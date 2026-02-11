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
}

[fleetUnits, idleShare, carryingCost].forEach((input) => {
  input?.addEventListener('input', updateEstimator);
});
updateEstimator();

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
