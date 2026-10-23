/**
 * UPERNIKAO TEXTIL — ENLACE BIO
 * Acordeones, paso de UTMs a la web y eventos de GA4 / Meta Pixel.
 */

document.addEventListener('DOMContentLoaded', () => {
  // ── UTMs: la bio se comparte como /bio?utm_source=instagram (o tiktok, etc.).
  // Si llega sin UTMs se marca como "bio", para que en GHL y el Sheet se vea que el lead vino de aquí.
  const incoming = new URLSearchParams(window.location.search);
  const utm = new URLSearchParams();
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'ttclid'].forEach(key => {
    const val = incoming.get(key);
    if (val) utm.set(key, val);
  });
  if (!utm.has('utm_source')) utm.set('utm_source', 'bio');
  if (!utm.has('utm_medium')) utm.set('utm_medium', 'bio');
  if (!utm.has('utm_campaign')) utm.set('utm_campaign', 'enlace_bio');

  // Propagar a los enlaces internos (misma web) para no perder la atribución
  document.querySelectorAll('a[href^="/"]').forEach(link => {
    try {
      const url = new URL(link.getAttribute('href'), window.location.origin);
      utm.forEach((val, key) => {
        if (!url.searchParams.has(key)) url.searchParams.set(key, val);
      });
      link.setAttribute('href', url.pathname + url.search + url.hash);
    } catch (err) { /* enlace inválido */ }
  });

  // ── ACORDEONES ──
  const cards = document.querySelectorAll('.accordion-card');

  function openAccordion(card) {
    const content = card.querySelector('.accordion-content');
    card.classList.add('active');
    card.querySelector('.accordion-trigger').setAttribute('aria-expanded', 'true');
    content.style.maxHeight = content.scrollHeight + 'px';
  }

  function closeAccordion(card) {
    card.classList.remove('active');
    card.querySelector('.accordion-trigger').setAttribute('aria-expanded', 'false');
    card.querySelector('.accordion-content').style.maxHeight = '0px';
  }

  cards.forEach(card => {
    card.querySelector('.accordion-trigger').addEventListener('click', () => {
      if (card.classList.contains('active')) {
        closeAccordion(card);
      } else {
        openAccordion(card);
        if (typeof gtag === 'function') {
          gtag('event', 'bio_open_section', { section: card.id.replace('acc-', '') });
        }
      }
    });
  });

  // Las imágenes dentro de un acordeón abierto cambian su alto al cargar
  window.addEventListener('resize', () => {
    cards.forEach(card => {
      if (card.classList.contains('active')) {
        const content = card.querySelector('.accordion-content');
        content.style.maxHeight = content.scrollHeight + 'px';
      }
    });
  });
  document.querySelectorAll('.accordion-content img').forEach(img => {
    img.addEventListener('load', () => window.dispatchEvent(new Event('resize')));
  });

  // Abrir una sección directo desde el enlace: /bio#acc-lineas
  const hashCard = window.location.hash ? document.querySelector(window.location.hash) : null;
  if (hashCard && hashCard.classList.contains('accordion-card')) {
    setTimeout(() => {
      openAccordion(hashCard);
      hashCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);
  }

  // ── TRACKING ──
  // Los clics no son leads (el lead se cuenta al enviar un formulario): se miden como interés.
  document.querySelectorAll('[data-track]').forEach(link => {
    link.addEventListener('click', () => {
      const label = link.getAttribute('data-track');
      const href = link.getAttribute('href') || '';

      if (typeof gtag === 'function') {
        gtag('event', 'bio_click', { link_name: label, link_url: href });
        if (href.includes('wa.me') || href.startsWith('tel:') || href.startsWith('mailto:')) {
          gtag('event', 'contact', { method: label });
        }
      }

      if (typeof fbq === 'function') {
        if (href.includes('wa.me') || href.startsWith('tel:')) {
          fbq('track', 'Contact', { content_name: label });
        } else if (href.includes('/cotizar')) {
          fbq('track', 'ViewContent', { content_name: label });
        }
      }
    });
  });
});
