/* ===== SMOOTH SCROLL ENGINE ===== */
let scrollY = window.scrollY;
let targetY = window.scrollY;
let ease = 0.08;
let isSmooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Only enable smooth scroll on desktop
if (isSmooth && window.innerWidth > 900) {
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  const scroller = document.createElement('div');
  scroller.id = 'smooth-scroller';
  scroller.style.cssText = 'position:fixed;top:0;left:0;width:100%;will-change:transform;';
  while (document.body.firstChild) scroller.appendChild(document.body.firstChild);
  document.body.appendChild(scroller);

  const ghost = document.createElement('div');
  ghost.style.cssText = 'pointer-events:none;';
  document.body.appendChild(ghost);

  function setHeight() {
    ghost.style.height = scroller.scrollHeight + 'px';
  }
  setHeight();
  new ResizeObserver(setHeight).observe(scroller);

  window.addEventListener('scroll', () => { targetY = window.scrollY; }, { passive: true });

  function tick() {
    scrollY += (targetY - scrollY) * ease;
    if (Math.abs(targetY - scrollY) < 0.05) scrollY = targetY;
    scroller.style.transform = `translateY(${-scrollY}px)`;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
} else {
  scrollY = window.scrollY;
  window.addEventListener('scroll', () => { scrollY = window.scrollY; }, { passive: true });
}

/* ===== NAV SCROLL STATE ===== */
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  const y = window.scrollY;
  if (y > 80) {
    navbar.classList.add('scrolled');
  } else {
    navbar.classList.remove('scrolled');
  }
}, { passive: true });

/* ===== MOBILE NAV ===== */
const navToggle = document.getElementById('navToggle');
const navMobile = document.getElementById('navMobile');
navToggle.addEventListener('click', () => navMobile.classList.toggle('open'));
document.querySelectorAll('.nav-mobile a').forEach(link => {
  link.addEventListener('click', () => navMobile.classList.remove('open'));
});

/* ===== HERO PARALLAX ===== */
const heroImg = document.querySelector('.hero-img img');
if (heroImg) {
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    heroImg.style.transform = `translateY(${y * 0.4}px)`;
  }, { passive: true });
}

/* ===== PARALLAX ON FEATURE IMAGES ===== */
function parallaxImages() {
  document.querySelectorAll('.row-img, .lead-img, .event-img').forEach(el => {
    const img = el.querySelector('img');
    if (!img) return;
    const rect = el.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    const vh = window.innerHeight;
    const offset = (center - vh / 2) * 0.12;
    img.style.transform = `translateY(${offset}px) scale(1.08)`;
  });
}
window.addEventListener('scroll', parallaxImages, { passive: true });
parallaxImages();

/* ===== SCROLL REVEAL ===== */
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('revealed');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.08, rootMargin: '0px 0px -60px 0px' });

// Assign reveal classes based on element type
document.querySelectorAll('.feature-row').forEach((el, i) => {
  el.classList.add('reveal-row');
  revealObserver.observe(el);
});

document.querySelectorAll('.event-card').forEach((el, i) => {
  el.classList.add('reveal-up');
  el.style.transitionDelay = `${(i % 2) * 0.1}s`;
  revealObserver.observe(el);
});

document.querySelectorAll('.pkg').forEach((el, i) => {
  el.classList.add('reveal-up');
  el.style.transitionDelay = `${i * 0.12}s`;
  revealObserver.observe(el);
});

document.querySelectorAll('.menu-photo-item').forEach((el, i) => {
  el.classList.add('reveal-up');
  el.style.transitionDelay = `${(i % 3) * 0.1}s`;
  revealObserver.observe(el);
});

document.querySelectorAll('.sg').forEach((el, i) => {
  el.classList.add('reveal-up');
  el.style.transitionDelay = `${(i % 4) * 0.07}s`;
  revealObserver.observe(el);
});

document.querySelectorAll('.rp-card').forEach((el, i) => {
  el.classList.add('reveal-up');
  el.style.transitionDelay = `${i * 0.1}s`;
  revealObserver.observe(el);
});

document.querySelectorAll('.insta-ph').forEach((el, i) => {
  el.classList.add('reveal-up');
  el.style.transitionDelay = `${i * 0.07}s`;
  revealObserver.observe(el);
});

document.querySelectorAll('.mini-review, .cf-left, .cf-right, .feature-lead, .cta-content').forEach(el => {
  el.classList.add('reveal-up');
  revealObserver.observe(el);
});

/* ===== MENU TABS ===== */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.menu-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const panel = document.getElementById('tab-' + tab.dataset.tab);
    panel.classList.add('active');
    // Re-observe newly shown items
    panel.querySelectorAll('.menu-photo-item, .pkg').forEach((el, i) => {
      el.classList.remove('revealed');
      el.style.transitionDelay = `${i * 0.07}s`;
      setTimeout(() => el.classList.add('revealed'), 50);
    });
  });
});

/* ===== CONTACT FORM → WHATSAPP ===== */
const contactForm = document.getElementById('contactForm');
if (contactForm) {
  contactForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = contactForm.name.value;
    const type = contactForm.type.value || 'General Enquiry';
    const message = contactForm.message.value;
    const phone = contactForm.phone.value;
    const parts = [
      `Hi Vivana Lounge! My name is ${name}.`,
      `Enquiry: ${type}`,
      message ? `Message: ${message}` : '',
      phone ? `Phone: ${phone}` : ''
    ].filter(Boolean).join('\n');
    window.open(`https://wa.me/447979099550?text=${encodeURIComponent(parts)}`, '_blank');
  });
}

/* ===== CURSOR GLOW (desktop only) ===== */
if (window.innerWidth > 900) {
  const cursor = document.createElement('div');
  cursor.id = 'cursor-glow';
  document.body.appendChild(cursor);
  let cx = 0, cy = 0, tx = 0, ty = 0;
  document.addEventListener('mousemove', e => { tx = e.clientX; ty = e.clientY; });
  function moveCursor() {
    cx += (tx - cx) * 0.12;
    cy += (ty - cy) * 0.12;
    cursor.style.transform = `translate(${cx}px, ${cy}px)`;
    requestAnimationFrame(moveCursor);
  }
  moveCursor();
  document.querySelectorAll('a, button, .menu-photo-item, .sg, .insta-ph').forEach(el => {
    el.addEventListener('mouseenter', () => cursor.classList.add('large'));
    el.addEventListener('mouseleave', () => cursor.classList.remove('large'));
  });
}
