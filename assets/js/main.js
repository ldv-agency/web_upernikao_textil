/**
 * UPERNIKAO TEXTIL - INTERACTIVIDAD Y LÓGICA DE CONVERSIÓN
 * Manejo de Menú, Filtros, Slider de Reseñas, FAQ y Formulario Inteligente WhatsApp
 */

// Número de WhatsApp de Upernikao Textil (Accesible globalmente)
// TODO: reemplazar por el número comercial definitivo de la marca
const WHATSAPP_NUMERO = '584248335228';
window.WHATSAPP_NUMERO = WHATSAPP_NUMERO;

// Webhook de n8n que recibe los leads (Sheet, Telegram, GHL, emails, Meta CAPI)
const LEAD_WEBHOOK_URL = 'https://n8n.srv1402866.hstgr.cloud/webhook/prospectos_upernikao';

// ── TRACKING UTM & IDENTIFICADORES DE CLICK ──
// Se guardan en localStorage (90 días) para no perder la atribución si el lead
// vuelve otro día. "Primer toque" no se sobrescribe; "último toque" sí.
const TRACKING_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'ttclid'
];
const TRACKING_STORE_KEY = 'upernikao_tracking';
const TRACKING_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PAGE_LOADED_AT = Date.now();

function readTrackingStore() {
  try {
    const stored = JSON.parse(localStorage.getItem(TRACKING_STORE_KEY) || 'null');
    if (stored && Date.now() - stored.updatedAt < TRACKING_TTL_MS) return stored;
  } catch (err) { /* almacenamiento bloqueado */ }
  return null;
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : '';
}

function initUtmTracking() {
  const urlParams = new URLSearchParams(window.location.search);
  const fromUrl = {};
  TRACKING_KEYS.forEach(key => {
    const val = (urlParams.get(key) || '').trim();
    if (val) fromUrl[key] = val.slice(0, 300);
  });
  const hasAnyTrackingInUrl = Object.keys(fromUrl).length > 0;

  // Sin UTM: deducir el canal por el referrer (Instagram, Facebook, Google...)
  if (!hasAnyTrackingInUrl && document.referrer) {
    let refHost = '';
    try { refHost = new URL(document.referrer).hostname; } catch (err) { /* referrer inválido */ }
    if (refHost && refHost !== window.location.hostname) {
      fromUrl.utm_source = refHost.replace(/^www\./, '').replace(/^(l|lm|m)\./, '');
      fromUrl.utm_medium = 'referral';
    }
  }

  const store = readTrackingStore() || {};
  const touch = Object.keys(fromUrl).length > 0
    ? Object.assign({ landing_page: window.location.href.slice(0, 500), referrer: document.referrer.slice(0, 300), at: new Date().toISOString() }, fromUrl)
    : null;

  if (touch) {
    if (!store.first) store.first = touch;
    store.last = touch;
  }
  if (!store.first_landing) store.first_landing = window.location.href.slice(0, 500);
  store.updatedAt = Date.now();

  try {
    localStorage.setItem(TRACKING_STORE_KEY, JSON.stringify(store));
  } catch (err) {
    console.warn('UTM tracking: almacenamiento bloqueado', err);
  }

  // Si llega desde un anuncio de Meta sin cookie _fbc, construirla como lo haría el Pixel
  if (fromUrl.fbclid && !getCookie('_fbc')) {
    const fbc = 'fb.1.' + Date.now() + '.' + fromUrl.fbclid;
    document.cookie = '_fbc=' + fbc + '; path=/; max-age=7776000; SameSite=Lax';
  }

  // Helper global: atribución de último toque (lo que viaja a n8n y GHL)
  window.getUtmParams = function() {
    const current = readTrackingStore() || store;
    const last = current.last || {};
    const data = {};
    TRACKING_KEYS.forEach(key => {
      data[key] = last[key] || '';
    });
    if (!data.utm_source) data.utm_source = 'Organico';
    if (!data.utm_medium) data.utm_medium = 'Web';
    return data;
  };

  // Contexto completo para el payload del lead
  window.getTrackingContext = function() {
    const current = readTrackingStore() || store;
    const first = current.first || {};
    return {
      first_utm_source: first.utm_source || '',
      first_utm_medium: first.utm_medium || '',
      first_utm_campaign: first.utm_campaign || '',
      landing_page: (current.last && current.last.landing_page) || current.first_landing || window.location.href,
      first_landing_page: first.landing_page || current.first_landing || '',
      referrer: (current.last && current.last.referrer) || document.referrer || '',
      current_page: window.location.href.slice(0, 500),
      fbp: getCookie('_fbp'),
      fbc: getCookie('_fbc')
    };
  };

  window.syncTrackingToForms = syncTrackingToForms;
}

function syncTrackingToForms() {
  try {
    const forms = document.querySelectorAll('form');
    if (!forms || forms.length === 0) return;

    const trackingData = window.getUtmParams ? window.getUtmParams() : {};

    forms.forEach(form => {
      TRACKING_KEYS.forEach(key => {
        let input = form.querySelector(`input[name="${key}"]`);
        if (!input) {
          input = document.createElement('input');
          input.type = 'hidden';
          input.name = key;
          form.appendChild(input);
        }
        input.value = trackingData[key] || '';
      });
    });
  } catch (e) {
    console.warn('Error sincronizando UTMs a formularios:', e);
  }
}

// ── ENVÍO DE LEADS A N8N ──
function generateEventId() {
  if (window.crypto && crypto.randomUUID) return 'lead_' + crypto.randomUUID();
  return 'lead_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}

function getDeviceType() {
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Móvil' : 'Escritorio';
}

/**
 * Envía el lead al webhook de n8n. Usa keepalive para que el envío termine
 * aunque el usuario salga de la página (WhatsApp o /gracias).
 * Devuelve true si el webhook respondió OK.
 */
window.sendLead = async function(lead) {
  const payload = Object.assign(
    {},
    lead,
    window.getUtmParams ? window.getUtmParams() : {},
    window.getTrackingContext ? window.getTrackingContext() : {},
    {
      device: getDeviceType(),
      elapsed_ms: Date.now() - PAGE_LOADED_AT,
      submitted_at: new Date().toISOString()
    }
  );

  // Evento para Google Tag Manager / Meta Pixel (mismo event_id que la API de Conversiones)
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({
    event: 'generate_lead',
    form_type: payload.formType,
    event_id: payload.event_id,
    lead_product: payload.product,
    lead_quantity: payload.quantity
  });

  // Respaldo local por si el webhook falla
  try {
    localStorage.setItem('upernikao_ultimo_lead', JSON.stringify(payload));
  } catch (err) { /* almacenamiento bloqueado */ }

  try {
    const res = await fetch(LEAD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    });
    return res.ok;
  } catch (err) {
    console.warn('No se pudo enviar el lead al webhook:', err);
    return false;
  }
};

// Ejecutar extracción inmediatamente al cargar el script
initUtmTracking();

document.addEventListener('DOMContentLoaded', () => {
  // Sincronizar UTMs a los formularios existentes en el DOM
  syncTrackingToForms();

  // ── 1. AÑO ACTUAL EN FOOTER ──
  const yearEl = document.getElementById('currentYear');
  if (yearEl) {
    yearEl.textContent = new Date().getFullYear();
  }

  // ── 2. MENÚ MÓVIL (DRAWER) ──
  const mobileToggle = document.getElementById('mobileToggle');
  const navMenu = document.getElementById('navMenu');

  if (mobileToggle && navMenu) {
    mobileToggle.addEventListener('click', () => {
      navMenu.classList.toggle('open');
      const isOpen = navMenu.classList.contains('open');
      mobileToggle.setAttribute('aria-expanded', isOpen);
    });

    // Cerrar al hacer clic en un enlace
    document.querySelectorAll('.nav-link, .nav-btn').forEach(link => {
      link.addEventListener('click', () => {
        navMenu.classList.remove('open');
      });
    });
  }

  // ── 2.1 SCROLL DIRECTO AL FORMULARIO EN MÓVIL AL CLICKEAR COTIZACIÓN ──
  document.querySelectorAll('a[href="#cotizacion"]').forEach(link => {
    link.addEventListener('click', (e) => {
      if (window.innerWidth <= 768) {
        e.preventDefault();
        const formCard = document.getElementById('quoteFormCard') || document.querySelector('.quote-form-card');
        if (formCard) {
          formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        if (navMenu && navMenu.classList.contains('open')) {
          navMenu.classList.remove('open');
          if (mobileToggle) mobileToggle.setAttribute('aria-expanded', 'false');
        }
      }
    });
  });

  // ── 3. NAVBAR STICKY & ENLACES ACTIVOS ──
  const navbar = document.getElementById('navbar');
  const sections = document.querySelectorAll('section[id]');

  window.addEventListener('scroll', () => {
    // Sombra dinámica
    if (window.scrollY > 40) {
      navbar.style.boxShadow = '0 4px 20px rgba(38, 10, 19, 0.12)';
    } else {
      navbar.style.boxShadow = '0 2px 10px rgba(38, 10, 19, 0.05)';
    }

    // Indicador de sección activa
    let currentId = '';
    const scrollPos = window.scrollY + 140;

    sections.forEach(sec => {
      const top = sec.offsetTop;
      const height = sec.offsetHeight;
      if (scrollPos >= top && scrollPos < top + height) {
        currentId = sec.getAttribute('id');
      }
    });

    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.remove('active');
      if (link.getAttribute('href') === `#${currentId}`) {
        link.classList.add('active');
      }
    });
  });





  // ── 6. FORMULARIO B2B DE COTIZACIÓN ──
  const quoteForm = document.getElementById('quoteForm');
  const submitBtn = document.getElementById('submitBtn');
  const formStatus = document.getElementById('formStatus');

  // Configuración del número de WhatsApp Oficial
  // Puedes actualizar este número fácilmente por el número comercial real de Upernikao Textil
  const officialWaNumber = WHATSAPP_NUMERO;

  /**
   * Genera el texto estructurado para WhatsApp a partir de los datos del formulario
   */
  function buildWhatsAppMessage() {
    const nombre = document.getElementById('nombre').value.trim();
    const apellido = document.getElementById('apellido').value.trim();
    const email = document.getElementById('email').value.trim();
    const codigoPais = document.getElementById('codigoPais').value;
    const telefono = document.getElementById('telefono').value.trim();
    const empresa = document.getElementById('empresa').value.trim() || 'No especificada';
    const cargo = document.getElementById('cargo').value.trim() || 'No especificado';
    const estado = document.getElementById('estado').value || 'No seleccionado';
    const sector = document.getElementById('sector').value || 'No seleccionado';
    const producto = document.getElementById('producto').value || 'No seleccionado';
    const cantidad = document.getElementById('cantidad').value || 'Por definir';
    const personalizacion = document.getElementById('personalizacion').value || 'Por asesorar';
    const presupuesto = document.getElementById('presupuesto').value || 'No especificado';
    const fechaEntrega = document.getElementById('fechaEntrega').value || 'Flexible';
    const comentarios = document.getElementById('comentarios').value.trim() || 'Sin comentarios adicionales';

    const msg = 
`👑 *SOLICITUD DE COTIZACIÓN - UPERNIKAO TEXTIL*
━━━━━━━━━━━━━━━━━━━━━━━━
👤 *Contacto:* ${nombre} ${apellido}
🏢 *Empresa:* ${empresa} (${cargo})
📍 *Ubicación:* ${estado}
🏭 *Sector:* ${sector}
📧 *Email:* ${email}
📱 *WhatsApp:* ${codigoPais} ${telefono}

🧵 *Tipo de Producto:* ${producto}
📦 *Cantidad:* ${cantidad} piezas
🎨 *Personalización:* ${personalizacion}
💰 *Presupuesto estimado:* ${presupuesto}
📅 *Fecha requerida:* ${fechaEntrega}

📝 *Comentarios adicionales:*
"${comentarios}"
━━━━━━━━━━━━━━━━━━━━━━━━
_Enviado desde el portal web oficial de Upernikao Textil_`;

    return encodeURIComponent(msg);
  }

  // ── 6.1 MULTI-PASO MÓVIL (STEPPER) ──
  const btnNextStep = document.getElementById('btnNextStep');
  const btnPrevStep = document.getElementById('btnPrevStep');
  const formStepPane1 = document.getElementById('formStepPane1');
  const formStepPane2 = document.getElementById('formStepPane2');
  const stepIndicator1 = document.getElementById('stepIndicator1');
  const stepIndicator2 = document.getElementById('stepIndicator2');
  const stepperProgress = document.getElementById('stepperProgress');

  function validateStep1() {
    const producto = document.getElementById('producto');
    const cantidad = document.getElementById('cantidad');
    const sector = document.getElementById('sector');

    if (!producto || !producto.value) {
      showStatus('Por favor selecciona el tipo de prenda o dotación que deseas confeccionar.', 'error');
      if (producto) producto.focus();
      return false;
    }

    const cantNum = parseInt(cantidad ? cantidad.value : 0, 10);
    if (!cantidad || !cantidad.value || isNaN(cantNum) || cantNum < 12) {
      showStatus('Por favor ingresa una cantidad estimada válida (mínimo 12 piezas).', 'error');
      if (cantidad) cantidad.focus();
      return false;
    }

    if (!sector || !sector.value) {
      showStatus('Por favor selecciona tu sector o tipo de institución.', 'error');
      if (sector) sector.focus();
      return false;
    }

    if (formStatus) formStatus.style.display = 'none';
    return true;
  }

  function setFormStep(step) {
    if (!formStepPane1 || !formStepPane2) return;

    if (step === 2) {
      formStepPane1.classList.remove('active');
      formStepPane2.classList.add('active');
      if (stepIndicator1) {
        stepIndicator1.classList.remove('active');
        stepIndicator1.classList.add('completed');
      }
      if (stepIndicator2) {
        stepIndicator2.classList.add('active');
      }
      if (stepperProgress) {
        stepperProgress.style.width = '100%';
      }
    } else {
      formStepPane2.classList.remove('active');
      formStepPane1.classList.add('active');
      if (stepIndicator2) {
        stepIndicator2.classList.remove('active');
      }
      if (stepIndicator1) {
        stepIndicator1.classList.add('active');
        stepIndicator1.classList.remove('completed');
      }
      if (stepperProgress) {
        stepperProgress.style.width = '50%';
      }
    }

    // Scroll suave hacia la cabecera del formulario en móvil
    const formCard = document.querySelector('.quote-form-card');
    if (formCard && window.innerWidth <= 768) {
      formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  if (btnNextStep) {
    btnNextStep.addEventListener('click', () => {
      if (validateStep1()) {
        setFormStep(2);
      }
    });
  }

  if (btnPrevStep) {
    btnPrevStep.addEventListener('click', () => {
      setFormStep(1);
    });
  }

  if (stepIndicator1) {
    stepIndicator1.addEventListener('click', () => {
      setFormStep(1);
    });
  }

  // Envío tradicional del Formulario
  if (quoteForm) {
    quoteForm.addEventListener('submit', (e) => {
      e.preventDefault();

      const nombre = document.getElementById('nombre').value.trim();
      const apellido = document.getElementById('apellido').value.trim();
      const email = document.getElementById('email').value.trim();
      const telefono = document.getElementById('telefono').value.trim();
      const estado = document.getElementById('estado').value;
      const sector = document.getElementById('sector').value;
      const producto = document.getElementById('producto').value;
      const cantidad = document.getElementById('cantidad').value;

      if (!nombre || !apellido || !email || !telefono || !estado || !sector || !producto || !cantidad) {
        showStatus('Por favor completa todos los campos requeridos (*).', 'error');
        return;
      }

      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
        showStatus('Por favor ingresa un correo electrónico válido.', 'error');
        document.getElementById('email').focus();
        return;
      }

      const cleanTel = telefono.replace(/\D/g, '').replace(/^0/, '');
      if (cleanTel.length < 10) {
        showStatus('Por favor ingresa un número de teléfono válido (mínimo 10 dígitos).', 'error');
        document.getElementById('telefono').focus();
        return;
      }

      const consent = document.getElementById('consentQuote');
      if (consent && !consent.checked) {
        showStatus('Debes aceptar la política de privacidad para enviar tu solicitud.', 'error');
        consent.focus();
        return;
      }

      // Feedback visual de envío
      const originalText = submitBtn.innerHTML;
      submitBtn.innerHTML = '<span>ENVIANDO SOLICITUD...</span>';
      submitBtn.disabled = true;

      const codigoPais = document.getElementById('codigoPais').value;
      const lead = {
        formType: 'quote_form',
        event_id: generateEventId(),
        hp: (quoteForm.querySelector('input[name="website"]') || {}).value || '',
        firstName: nombre,
        lastName: apellido,
        email: email,
        phone: `${codigoPais}${cleanTel}`,
        company: document.getElementById('empresa').value.trim(),
        role: document.getElementById('cargo').value.trim(),
        state: estado,
        sector: sector,
        product: producto,
        quantity: cantidad,
        customization: document.getElementById('personalizacion').value,
        budget: document.getElementById('presupuesto').value,
        deliveryDate: document.getElementById('fechaEntrega').value,
        message: document.getElementById('comentarios').value.trim(),
        consent: true
      };

      window.sendLead(lead).then((ok) => {
        submitBtn.innerHTML = originalText;
        submitBtn.disabled = false;

        if (!ok) {
          // El webhook falló: no perder el lead, ofrecer WhatsApp con todos los datos
          showStatus('No pudimos registrar tu solicitud automáticamente. Envíanosla por WhatsApp con un clic:', 'error');
          const waLink = document.createElement('a');
          waLink.href = `https://wa.me/${officialWaNumber}?text=${buildWhatsAppMessage()}`;
          waLink.target = '_blank';
          waLink.rel = 'noopener';
          waLink.className = 'btn btn-primary btn-block';
          waLink.style.marginTop = '10px';
          waLink.textContent = 'Enviar solicitud por WhatsApp';
          formStatus.appendChild(waLink);
          return;
        }

        try {
          sessionStorage.setItem('upernikao_gracias', JSON.stringify({
            nombre, producto, cantidad, formType: 'quote_form', event_id: lead.event_id,
            waText: decodeURIComponent(buildWhatsAppMessage())
          }));
        } catch (err) { /* almacenamiento bloqueado */ }
        window.location.href = '/gracias.html';
      });
    });
  }

  function showStatus(message, type) {
    if (!formStatus) return;
    formStatus.textContent = message;
    formStatus.className = `form-status ${type}`;
    formStatus.style.display = 'block';

    setTimeout(() => {
      formStatus.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
  }

  // ── 7. MICRO-ANIMACIONES EN SCROLL (OBSERVER) ──
  const animatedElements = document.querySelectorAll(
    '.line-card, .tech-card, .pillar-card, .review-card, .gallery-item, .faq-item, .stat-card-glass'
  );

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  animatedElements.forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(24px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    observer.observe(el);
  });

  // Accesibilidad de teclado para tarjetas de catálogo
  document.querySelectorAll('.line-card').forEach(card => {
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        card.click();
      }
    });
  });

  // Inicializar banner influenciador persuasivo
  initQuoteBanner();

  // Inicializar modal rápido de WhatsApp
  initWaModal();

  // Links cortos de campañas (/cotizar, /cotizar/<línea>, /whatsapp)
  initCampaignLanding();
});

// ── 8. DATOS DEL CATÁLOGO DE CONFECCIÓN (MODAL INTERACTIVO) ──
const linesCatalogData = {
  corp: {
    tag: 'CORPORATIVO',
    title: 'Línea Corporativa & Ejecutiva',
    img: '/assets/images/barcelona-anzoategui-upernikao-textil-lineacorporativa.webp',
    desc: 'Prendas elegantes y cómodas que transmiten solidez profesional, confianza y presencia de marca ante clientes en oficinas, atención al público y eventos.',
    items: [
      'Camisas y blusas ejecutivas en tela Oxford y Popelina con bordado milimétrico',
      'Pantalones ejecutivos de vestir dama y caballero con corte anatómico',
      'Chemises polo en piqué de algodón peinado (220g)',
      'Chalecos corporativos y blazers ejecutivos con forro de satén'
    ],
    features: ['Bordado computarizado milimétrico', 'Telas frescas y antiarrugas', 'Corte anatómico dama y caballero'],
    productVal: 'Camisería & Pantalones'
  },
  ind: {
    tag: 'INDUSTRIAL',
    title: 'Línea Industrial & Seguridad',
    img: '/assets/images/barcelona-anzoategui-upernikao-textil-lineaindustrial.webp',
    desc: 'Confección reforzada de máxima resistencia para soportar las condiciones operativas más exigentes en plantas, talleres mecánicos, construcción y faena.',
    items: [
      'Bragas petroleras y de faena con doble y triple costura de seguridad',
      'Pantalones cargo con bolsillos tácticos utilitarios y refuerzo',
      'Chalecos de seguridad con cintas reflectivas 3M homologadas',
      'Camisas de faena en dril de algodón 100% y gabardina pesada'
    ],
    features: ['Costuras reforzadas anti-desgarre', 'Cintas reflectivas de alta visibilidad', 'Resistencia al uso rudo y abrasión'],
    productVal: 'Uniformes Industriales'
  },
  med: {
    tag: 'SALUD Y CLÍNICA',
    title: 'Línea Médica, Salud & Belleza',
    img: '/assets/images/barcelona-anzoategui-upernikao-textil-lineamedica.webp',
    desc: 'Scrubs y uniformes clínicos con tecnología textil antifluido y elasticidad, concebidos para ofrecer confort superior en jornadas de trabajo continuas.',
    items: [
      'Conjuntos de scrubs quirúrgicos en tela antifluido stretch',
      'Batas médicas y de laboratorio ergonómicas con ajuste impecable',
      'Filipinas para odontología, estética, spa y fisioterapia',
      'Gorros clínicos y tapabocas personalizados a tono'
    ],
    features: ['Repelencia certificada a fluidos', 'Tela stretch ultra transpirable', 'Secado rápido y cero arrugas'],
    productVal: 'Dotación Médica'
  },
  chef: {
    tag: 'GASTRONOMÍA',
    title: 'Línea Gastronómica & Hotelería',
    img: '/assets/images/barcelona-anzoategui-upernikao-textil-lineagastronomica.webp',
    desc: 'Estilo contemporáneo, comodidad y alta transpirabilidad para chefs, cocineros, baristas, brigadas de cocina y staff de salón.',
    items: [
      'Filipinas de chef con paneles transpirables de malla en espalda',
      'Delantales de barista y cocina en lona pesada con remaches y cuero',
      'Gorros de cocina, cofias y bandanas ajustables',
      'Camisas y delantales para capitanes de meseros y personal de sala'
    ],
    features: ['Resistencia al calor y grasas', 'Acabados antimanchas de fácil lavado', 'Diseño moderno de autor'],
    productVal: 'Dotación Gastronómica'
  },
  dep: {
    tag: 'DEPORTIVO & EVENTOS',
    title: 'Línea Deportiva, Escolar & Urbana',
    img: '/assets/images/barcelona-anzoategui-upernikao-textil-lineadeportiva.webp',
    desc: 'Textiles livianos, secado rápido y protección climática para colegios, clubes deportivos, activaciones de marca y eventos masivos.',
    items: [
      'Franelas técnicas deportivas en tela Dry-Fit microperforada',
      'Chaquetas cortavientos impermeables con capucha ajustable',
      'Monos deportivos y sudaderas con capucha en felpa o perchado',
      'Uniformes escolares reglamentarios y conjuntos deportivos de gala'
    ],
    features: ['Tecnología Dry-Fit antitranspirante', 'Protección contra viento y llovizna', 'Sublimación digital full cover o DTF'],
    productVal: 'Chaquetas & Cortavientos'
  },
  pop: {
    tag: 'MERCHANDISING',
    title: 'Merchandising & POP Textil',
    img: '/assets/images/barcelona-anzoategui-upernikao-textil-lineapop.webp',
    desc: 'Accesorios y prendas de vestir promocionales de alto impacto para campañas de branding, fidelización de clientes, lanzamientos y exposiciones.',
    items: [
      'Gorras trucker, planas y estructuradas con bordado 3D',
      'Tote bags y bolsas ecológicas reutilizables de alta resistencia',
      'Bandanas, toallas deportivas y pañuelos con estampado de marca',
      'Prendas especiales para activaciones masivas y dotación promocional'
    ],
    features: ['Alta recordación de marca', 'Acabados gráficos de máxima definición', 'Producción flexible desde 12 piezas'],
    productVal: 'Material POP & Gorras'
  }
};

let currentModalProductVal = '';

/**
 * Abrir Modal de Detalles con Efecto Blur
 */
window.openLineModal = function(lineId) {
  const data = linesCatalogData[lineId];
  if (!data) return;

  // GA4: qué líneas del catálogo generan más interés
  if (window.gtag) {
    gtag('event', 'view_item', {
      currency: 'USD',
      value: 0,
      items: [{ item_id: lineId, item_name: data.title, item_category: data.productVal }]
    });
  }

  const modal = document.getElementById('lineModal');
  const modalImg = document.getElementById('modalImg');
  const modalTag = document.getElementById('modalTag');
  const modalTitle = document.getElementById('modalTitle');
  const modalDesc = document.getElementById('modalDesc');
  const modalItems = document.getElementById('modalItems');
  const modalFeatures = document.getElementById('modalFeatures');
  const modalQuoteBtn = document.getElementById('modalQuoteBtn');

  if (!modal) return;

  currentModalProductVal = data.productVal;

  if (modalImg) {
    modalImg.src = data.img;
    modalImg.alt = data.title;
  }
  if (modalTag) modalTag.textContent = data.tag;
  if (modalTitle) modalTitle.textContent = data.title;
  if (modalDesc) modalDesc.textContent = data.desc;

  if (modalItems) {
    modalItems.innerHTML = data.items.map(item => `<li>${item}</li>`).join('');
  }

  if (modalFeatures) {
    modalFeatures.innerHTML = data.features.map(f => `<span class="feature-pill">${f}</span>`).join('');
  }

  if (modalQuoteBtn) {
    modalQuoteBtn.onclick = () => {
      closeLineModal();
      setTimeout(() => {
        preselectProduct(data.productVal);
      }, 150);
    };
  }

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
};

/**
 * Cerrar Modal de Detalles
 */
window.closeLineModal = function() {
  const modal = document.getElementById('lineModal');
  if (modal) {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }
};

/**
 * Datos para el Pop-up de Galería (Fotos de Resultados & Modelos)
 */
const galleryCatalogData = {
  corp: {
    tag: 'CORPORATIVO & EJECUTIVO',
    title: 'Camisas Ejecutivas Oxford y Chemises Corporativas',
    productVal: 'Camisería & Pantalones',
    photos: [
      '/assets/images/barcelona-anzoategui-upernikao-textil-lineacorporativa.webp',
      '/assets/images/form_showcase.jpg',
      '/assets/images/about_textil.jpg'
    ],
    captions: [
      'Camisas Ejecutivas Oxford y Pantalones de Vestir con Bordado Corporativo',
      'Bordados Computarizados Milimétricos en Cuello, Pecho y Manga',
      'Patronaje Ergonómico y Acabados de Confección Corporativa'
    ]
  },
  ind: {
    tag: 'INDUSTRIAL & PETROLERA',
    title: 'Bragas Petroleras y Chaquetas Reflectivas 3M',
    productVal: 'Uniformes Industriales',
    photos: [
      '/assets/images/barcelona-anzoategui-upernikao-textil-lineaindustrial.webp',
      '/assets/images/hero_textil_bg.jpg',
      '/assets/images/tecnica_bordado.jpg'
    ],
    captions: [
      'Bragas Petroleras de Alta Resistencia con Bandas Reflectivas 3M',
      'Costuras Triples de Seguridad y Cierres de Bronce de Faena',
      'Personalización de Logotipos Empresariales de Alto Tráfico'
    ]
  },
  med: {
    tag: 'SALUD & CLÍNICA',
    title: 'Conjuntos de Scrubs Quirúrgicos Antifluido',
    productVal: 'Dotación Médica',
    photos: [
      '/assets/images/barcelona-anzoategui-upernikao-textil-lineamedica.webp',
      '/assets/images/form_showcase.jpg',
      '/assets/images/tecnica_dtf.jpg'
    ],
    captions: [
      'Conjunto Scrub Quirúrgico Antifluido Anatómico y Fresco',
      'Bolsillos Cargo Funcionales y Tela Repelente a Manchas',
      'Bordado y Personalización Institucional de Alta Precisión'
    ]
  },
  chef: {
    tag: 'GASTRONOMÍA & SERVICIO',
    title: 'Filipinas de Chef y Delantales en Lona',
    productVal: 'Dotación Gastronómica',
    photos: [
      '/assets/images/barcelona-anzoategui-upernikao-textil-lineagastronomica.webp',
      '/assets/images/about_textil.jpg',
      '/assets/images/uniforme_corporativo.jpg'
    ],
    captions: [
      'Filipina de Chef con Respiraderos Térmicos Laterales',
      'Delantales Barista en Lona Drill con Remaches y Herrajes',
      'Dotaciones Completas para Personal de Cocina y Salón'
    ]
  },
  dep: {
    tag: 'DEPORTIVO & STAFF',
    title: 'Franelas Técnicas Dry-Fit y Cortavientos',
    productVal: 'Chaquetas & Cortavientos',
    photos: [
      '/assets/images/barcelona-anzoategui-upernikao-textil-lineadeportiva.webp',
      '/assets/images/tecnica_dtf.jpg',
      '/assets/images/form_showcase.jpg'
    ],
    captions: [
      'Franelas Técnicas Dry-Fit Microperforadas de Secado Veloz',
      'Sublimación Digital Ultra HD y DTF Textil a Full Color',
      'Chaquetas Cortavientos Impermeables con Capucha Ajustable'
    ]
  },
  pop: {
    tag: 'MERCHANDISING & POP',
    title: 'Gorras Estructuradas y Bolsas Ecológicas',
    productVal: 'Material POP & Gorras',
    photos: [
      '/assets/images/barcelona-anzoategui-upernikao-textil-lineapop.webp',
      '/assets/images/tecnica_bordado.jpg',
      '/assets/images/tecnica_dtf.jpg'
    ],
    captions: [
      'Gorras Estructuradas con Bordado 3D de Alto Relieve',
      'Bolsas Ecológicas Reutilizables en Tocuyo y Lona Resistente',
      'Accesorios Publicitarios de Gran Impacto y Fidelización'
    ]
  }
};

let currentGalleryId = 'corp';
let currentGallerySlideIdx = 0;

/**
 * Abrir Modal Slider de Galería (Solo Fotos, Deslizable en Ambos Sentidos)
 */
window.openGalleryModal = function(galleryId) {
  const data = galleryCatalogData[galleryId];
  if (!data) return;

  currentGalleryId = galleryId;
  currentGallerySlideIdx = 0;

  const modal = document.getElementById('galleryModal');
  const modalTag = document.getElementById('gModalTag');
  const modalTitle = document.getElementById('gModalTitle');
  const modalQuoteBtn = document.getElementById('gModalUniversalQuoteBtn');

  if (!modal) return;

  if (modalTag) modalTag.textContent = data.tag;
  if (modalTitle) modalTitle.textContent = data.title;

  // Generar miniaturas centradas
  const thumbsContainer = document.getElementById('gModalThumbs');
  if (thumbsContainer && data.photos) {
    thumbsContainer.innerHTML = data.photos.map((photo, idx) => `
      <button type="button" class="gmodal-thumb ${idx === 0 ? 'active' : ''}" onclick="goToGallerySlide(${idx})" aria-label="Ver foto ${idx + 1}">
        <img src="${photo}" alt="Modelo ${idx + 1}" loading="lazy">
      </button>
    `).join('');
  }

  // Actualizar vista del slide inicial
  updateGallerySlideView();

  // Asignar acción al botón universal "Cotizar este modelo"
  if (modalQuoteBtn) {
    modalQuoteBtn.onclick = () => {
      closeGalleryModal();
      setTimeout(() => {
        preselectProduct(data.productVal);
      }, 150);
    };
  }

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
};

/**
 * Actualizar imagen, contador y pie de foto del slide activo
 */
window.updateGallerySlideView = function() {
  const data = galleryCatalogData[currentGalleryId];
  if (!data || !data.photos || data.photos.length === 0) return;

  const total = data.photos.length;
  if (currentGallerySlideIdx < 0) currentGallerySlideIdx = total - 1;
  if (currentGallerySlideIdx >= total) currentGallerySlideIdx = 0;

  const mainImg = document.getElementById('gModalImg');
  const counter = document.getElementById('gModalCounter');
  const caption = document.getElementById('gModalCaption');

  if (counter) {
    counter.textContent = `${currentGallerySlideIdx + 1} / ${total}`;
  }

  if (mainImg) {
    mainImg.style.opacity = '0.25';
    setTimeout(() => {
      mainImg.src = data.photos[currentGallerySlideIdx];
      mainImg.alt = (data.captions && data.captions[currentGallerySlideIdx]) || data.title;
      mainImg.style.opacity = '1';
    }, 100);
  }

  if (caption && data.captions) {
    caption.innerHTML = `<span>${data.captions[currentGallerySlideIdx] || ''}</span>`;
  }

  // Actualizar miniatura activa
  const thumbs = document.querySelectorAll('.gmodal-thumb');
  thumbs.forEach((thumb, idx) => {
    if (idx === currentGallerySlideIdx) {
      thumb.classList.add('active');
    } else {
      thumb.classList.remove('active');
    }
  });
};

/**
 * Deslizar en ambos sentidos (anterior / siguiente)
 */
window.changeGallerySlide = function(step) {
  currentGallerySlideIdx += step;
  updateGallerySlideView();
};

/**
 * Ir a un slide específico desde las miniaturas
 */
window.goToGallerySlide = function(idx) {
  currentGallerySlideIdx = idx;
  updateGallerySlideView();
};

/**
 * Cerrar Modal de Galería
 */
window.closeGalleryModal = function() {
  const modal = document.getElementById('galleryModal');
  if (modal) {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }
};

// Cerrar modales al hacer clic en el fondo con blur
document.addEventListener('click', (e) => {
  const lineModal = document.getElementById('lineModal');
  if (lineModal && lineModal.classList.contains('active') && e.target === lineModal) {
    closeLineModal();
  }
  const galleryModal = document.getElementById('galleryModal');
  if (galleryModal && galleryModal.classList.contains('active') && e.target === galleryModal) {
    closeGalleryModal();
  }
});

// Navegación con teclado (Flechas Izquierda / Derecha y tecla Escape)
document.addEventListener('keydown', (e) => {
  const galleryModal = document.getElementById('galleryModal');
  if (galleryModal && galleryModal.classList.contains('active')) {
    if (e.key === 'ArrowLeft') {
      changeGallerySlide(-1);
    } else if (e.key === 'ArrowRight') {
      changeGallerySlide(1);
    } else if (e.key === 'Escape') {
      closeGalleryModal();
    }
    return;
  }

  const lineModal = document.getElementById('lineModal');
  if (lineModal && lineModal.classList.contains('active') && e.key === 'Escape') {
    closeLineModal();
  }
});

// ── 9. OTRAS FUNCIONES GLOBALES ──
/**
 * Alternar apertura de acordeón FAQ
 */
window.toggleFaq = function(itemEl) {
  const isOpen = itemEl.classList.contains('open');
  document.querySelectorAll('.faq-item.open').forEach(item => {
    item.classList.remove('open');
  });
  if (!isOpen) {
    itemEl.classList.add('open');
  }
};

/**
 * Pre-seleccionar producto en el formulario desde los enlaces de catálogo
 */
window.preselectProduct = function(productValue) {
  const productSelect = document.getElementById('producto');
  if (productSelect) {
    productSelect.value = productValue;
  }
  const formCard = document.getElementById('quoteFormCard') || document.querySelector('.quote-form-card');
  const target = (window.innerWidth <= 768 && formCard) ? formCard : document.getElementById('cotizacion');
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};

// ── LINKS CORTOS PARA CAMPAÑAS ──
// vercel.json reescribe estas rutas a index.html; aquí se decide a dónde llevar al visitante.
// La URL se mantiene (con sus UTM y fbclid) para que n8n registre la página de entrada exacta.
const CAMPAIGN_LINE_PRODUCTS = {
  corporativa: 'Camisería & Pantalones',
  industrial: 'Uniformes Industriales',
  medica: 'Dotación Médica',
  gastronomica: 'Dotación Gastronómica',
  deportiva: 'Chaquetas & Cortavientos',
  pop: 'Material POP & Gorras',
  chemises: 'Chemises & Franelas'
};

function initCampaignLanding() {
  const parts = window.location.pathname.toLowerCase().replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length === 0) return;

  // Esperar a que el layout se asiente (imágenes del hero) antes de desplazar
  if (parts[0] === 'whatsapp') {
    setTimeout(() => window.openWaModal('Link_Campana_WhatsApp'), 400);
  } else if (parts[0] === 'cotizar') {
    const product = CAMPAIGN_LINE_PRODUCTS[parts[1]] || '';
    setTimeout(() => window.preselectProduct(product), 400);
  }
}

// ==========================================================================
// 12. BANNER INFLUENCIADOR PUBLICITARIO (LADO FORMULARIO - LOOP PERSUASIVO)
// ==========================================================================
const quoteBannerSlides = [
  {
    tag: 'IMAGEN CORPORATIVA DE IMPACTO',
    title: 'Tu Empresa Merece Lucir Impecable Ante Tus Clientes',
    desc: 'La primera impresión define contratos de alto valor. Diseñamos y confeccionamos la dotación de tu equipo con presencia impecable, patronaje exclusivo y acabados que inspiran respeto y confianza total.'
  },
  {
    tag: 'MÁXIMA RENTABILIDAD B2B',
    title: 'Ahorra con Precios Directos de Fábrica Sin Intermediarios',
    desc: 'Optimiza cada dólar de tu presupuesto corporativo. Al fabricar directamente para ti, te garantizamos costos competitivos al mayor, telas certificadas que no destiñen ni encogen y descuentos escalonados.'
  },
  {
    tag: 'PUNTUALIDAD GARANTIZADA',
    title: '¿Tienes una Fecha Límite? Entregamos a Tiempo Sin Excusas',
    desc: 'Sabemos lo crítico que es un retraso para tu operación. Gestionamos cronogramas de producción estrictos para eventos, lanzamientos y dotaciones periódicas con despacho asegurado.'
  },
  {
    tag: 'CONFORT & DURABILIDAD TEXTIL',
    title: 'Prendas Ergonómicas que tu Personal Amará Usar a Diario',
    desc: 'Ropa laboral fresca, con tecnología textil antifluido, costuras reforzadas y bordados computarizados de precisión. Menos desgaste, mayor durabilidad y comodidad en cada jornada.'
  }
];

let currentQuoteSlideIdx = 0;
let quoteBannerTimer = null;

function renderQuoteSlide(idx) {
  const stage = document.getElementById('quoteMessageStage');
  const tagEl = document.getElementById('quoteBannerTag');
  const titleEl = document.getElementById('quoteBannerTitle');
  const descEl = document.getElementById('quoteBannerDesc');
  const dots = document.querySelectorAll('#quoteBannerDots .v-dot');

  if (!stage || !tagEl || !titleEl || !descEl) return;

  stage.classList.add('fading');

  setTimeout(() => {
    const slide = quoteBannerSlides[idx];
    tagEl.textContent = slide.tag;
    titleEl.textContent = slide.title;
    descEl.textContent = slide.desc;

    dots.forEach((dot, dIdx) => {
      dot.classList.toggle('active', dIdx === idx);
    });

    stage.classList.remove('fading');
  }, 220);
}

function nextQuoteSlide() {
  currentQuoteSlideIdx = (currentQuoteSlideIdx + 1) % quoteBannerSlides.length;
  renderQuoteSlide(currentQuoteSlideIdx);
}

window.goToQuoteSlide = function(idx) {
  currentQuoteSlideIdx = idx;
  renderQuoteSlide(currentQuoteSlideIdx);
  startQuoteBannerTimer();
};

function startQuoteBannerTimer() {
  if (quoteBannerTimer) clearInterval(quoteBannerTimer);
  quoteBannerTimer = setInterval(nextQuoteSlide, 5200);
}

function initQuoteBanner() {
  const visualCard = document.getElementById('quoteVisualCard');
  if (visualCard) {
    visualCard.addEventListener('mouseenter', () => {
      if (quoteBannerTimer) clearInterval(quoteBannerTimer);
    });
    visualCard.addEventListener('mouseleave', () => {
      startQuoteBannerTimer();
    });
  }
  startQuoteBannerTimer();
}

// ── 15. MODAL DE WHATSAPP CON FORMULARIO PREVIO Y CONTADOR DE 10S (WHATSAPP TRACKING GATE) ──
let waCountdownInterval = null;
let waTargetRedirectUrl = '';
let currentWaOrigin = 'Boton_Flotante';

window.openWaModal = function(origin = 'Boton_Flotante') {
  currentWaOrigin = origin || 'Boton_Flotante';
  const modal = document.getElementById('waModal');
  const formScreen = document.getElementById('waFormScreen');
  const thanksScreen = document.getElementById('waThanksScreen');
  const errorEl = document.getElementById('waFormError');
  const quickForm = document.getElementById('waQuickForm');

  if (waCountdownInterval) {
    clearInterval(waCountdownInterval);
    waCountdownInterval = null;
  }

  if (quickForm) {
    quickForm.reset();
    if (typeof syncTrackingToForms === 'function') syncTrackingToForms();
  }
  if (errorEl) errorEl.style.display = 'none';

  if (formScreen) formScreen.style.display = 'block';
  if (thanksScreen) thanksScreen.style.display = 'none';

  if (modal) {
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    setTimeout(() => {
      const firstInput = document.getElementById('waNombre');
      if (firstInput) firstInput.focus();
    }, 150);
  }
};

window.closeWaModal = function() {
  const modal = document.getElementById('waModal');
  if (waCountdownInterval) {
    clearInterval(waCountdownInterval);
    waCountdownInterval = null;
  }
  if (modal) {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }
};

window.triggerWaRedirectNow = function() {
  if (waCountdownInterval) {
    clearInterval(waCountdownInterval);
    waCountdownInterval = null;
  }
  if (waTargetRedirectUrl) {
    window.open(waTargetRedirectUrl, '_blank');
  }
};

window.submitWaQuickForm = function(e) {
  if (e && e.preventDefault) e.preventDefault();

  const nombreInput = document.getElementById('waNombre');
  const apellidoInput = document.getElementById('waApellido');
  const emailInput = document.getElementById('waEmail');
  const codigoPaisInput = document.getElementById('waCodigoPais');
  const telefonoInput = document.getElementById('waTelefono');
  const productoInput = document.getElementById('waProducto');
  const cantidadInput = document.getElementById('waCantidad');
  const errorEl = document.getElementById('waFormError');

  if (!nombreInput || !apellidoInput || !emailInput || !telefonoInput || !productoInput || !cantidadInput) {
    return false;
  }

  const nombre = nombreInput.value.trim();
  const apellido = apellidoInput.value.trim();
  const email = emailInput.value.trim();
  const codigoPais = codigoPaisInput.value;
  const telefono = telefonoInput.value.trim();
  const producto = productoInput.value;
  const cantidad = cantidadInput.value.trim();

  // Validación de campos
  if (!nombre || !apellido || !email || !telefono || !producto || !cantidad) {
    if (errorEl) {
      errorEl.textContent = 'Por favor completa todos los campos requeridos (*).';
      errorEl.style.display = 'block';
    }
    return false;
  }

  // 1. Limpieza y validación del teléfono (quitar caracteres no numéricos y limpiar prefijo 0)
  let cleanTel = telefono.replace(/\D/g, '');
  if (cleanTel.startsWith('0')) {
    cleanTel = cleanTel.substring(1); // Ej: 04141234567 -> 4141234567
  }

  if (cleanTel.length < 10) {
    if (errorEl) {
      errorEl.textContent = 'Por favor ingresa un número de teléfono válido (mínimo 10 dígitos).';
      errorEl.style.display = 'block';
    }
    return false;
  }

  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
    if (errorEl) {
      errorEl.textContent = 'Por favor ingresa un correo electrónico válido.';
      errorEl.style.display = 'block';
    }
    return false;
  }

  const consent = document.getElementById('consentWa');
  if (consent && !consent.checked) {
    if (errorEl) {
      errorEl.textContent = 'Debes aceptar la política de privacidad para continuar.';
      errorEl.style.display = 'block';
    }
    return false;
  }

  if (errorEl) errorEl.style.display = 'none';

  // 2. Enviar el lead a n8n (keepalive: termina aunque el usuario salte a WhatsApp)
  const fullPhone = `${codigoPais} ${cleanTel}`;
  const quickForm = document.getElementById('waQuickForm');
  const eventId = generateEventId();

  // El modal no pasa por /gracias: el Lead del Pixel se dispara aquí con el mismo
  // eventID que n8n envía a la API de Conversiones (Meta deduplica ambos)
  if (window.fbq) {
    fbq('track', 'Lead', {
      content_name: producto,
      num_items: parseInt(cantidad, 10) || undefined,
      currency: 'USD',
      value: 0
    }, { eventID: eventId });
  }
  if (window.gtag) {
    gtag('event', 'generate_lead', {
      currency: 'USD',
      value: 0,
      lead_source: 'Formulario WhatsApp',
      item_name: producto,
      quantity: parseInt(cantidad, 10) || undefined,
      transaction_id: eventId,
      transport_type: 'beacon'
    });
  }

  window.sendLead({
    formType: 'whatsapp_modal',
    button_origin: currentWaOrigin || 'Boton_Flotante',
    event_id: eventId,
    hp: (quickForm && quickForm.querySelector('input[name="website"]') || {}).value || '',
    firstName: nombre,
    lastName: apellido,
    email: email,
    phone: `${codigoPais}${cleanTel}`,
    product: producto,
    quantity: cantidad,
    consent: true
  });

  const summaryName = document.getElementById('waSummaryName');
  const summaryFullname = document.getElementById('waSummaryFullname');
  const summaryEmail = document.getElementById('waSummaryEmail');
  const summaryPhone = document.getElementById('waSummaryPhone');
  const summaryProduct = document.getElementById('waSummaryProduct');
  const summaryQty = document.getElementById('waSummaryQty');

  if (summaryName) summaryName.textContent = nombre;
  if (summaryFullname) summaryFullname.textContent = `${nombre} ${apellido}`;
  if (summaryEmail) summaryEmail.textContent = email;
  if (summaryPhone) summaryPhone.textContent = fullPhone;
  if (summaryProduct) summaryProduct.textContent = producto;
  if (summaryQty) summaryQty.textContent = `${cantidad} piezas`;

  // Estructurar el mensaje para WhatsApp
  const waMsg = 
`👑 *SOLICITUD RÁPIDA VÍA WHATSAPP - UPERNIKAO TEXTIL*
━━━━━━━━━━━━━━━━━━━━━━━━
👤 *Cliente:* ${nombre} ${apellido}
📧 *Email:* ${email}
📞 *Teléfono para llamada:* ${fullPhone}
🧵 *Prenda / Producto:* ${producto}
📦 *Cantidad estimada:* ${cantidad} piezas
━━━━━━━━━━━━━━━━━━━━━━━━
_Solicitud iniciada desde la web oficial de Upernikao Textil_`;

  const waTargetNumber = WHATSAPP_NUMERO;
  waTargetRedirectUrl = `https://wa.me/${waTargetNumber}?text=${encodeURIComponent(waMsg)}`;

  // Cambiar INMEDIATAMENTE a pantalla de agradecimiento
  const formScreen = document.getElementById('waFormScreen');
  const thanksScreen = document.getElementById('waThanksScreen');
  if (formScreen) formScreen.style.display = 'none';
  if (thanksScreen) {
    thanksScreen.style.display = 'block';
    thanksScreen.scrollTop = 0;
  }

  // Desplazar el diálogo al tope
  const modalDialog = document.querySelector('.wa-modal-dialog');
  if (modalDialog) modalDialog.scrollTop = 0;

  // Cuenta regresiva corta; el botón permite abrir WhatsApp de inmediato
  const countdownTotal = 6;
  let secondsLeft = countdownTotal;
  const countdownNum = document.getElementById('waCountdownNum');
  const secondsText = document.getElementById('waSecondsText');
  const progressFill = document.getElementById('waProgressFill');

  if (countdownNum) countdownNum.textContent = secondsLeft;
  if (secondsText) secondsText.textContent = secondsLeft;
  if (progressFill) progressFill.style.width = '100%';

  if (waCountdownInterval) {
    clearInterval(waCountdownInterval);
    waCountdownInterval = null;
  }

  waCountdownInterval = setInterval(() => {
    secondsLeft--;
    if (countdownNum) countdownNum.textContent = secondsLeft;
    if (secondsText) secondsText.textContent = secondsLeft;
    if (progressFill) {
      const pct = Math.max(0, (secondsLeft / countdownTotal) * 100);
      progressFill.style.width = pct + '%';
    }

    if (secondsLeft <= 0) {
      clearInterval(waCountdownInterval);
      waCountdownInterval = null;
      // Navegar en la misma pestaña: window.open sin clic lo bloquean los navegadores móviles
      if (waTargetRedirectUrl) {
        window.location.href = waTargetRedirectUrl;
      }
    }
  }, 1000);

  return false;
};

function initWaModal() {
  const modal = document.getElementById('waModal');
  const quickForm = document.getElementById('waQuickForm');

  // Cerrar al hacer clic en el fondo oscuro
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeWaModal();
      }
    });
  }

  // Cerrar con tecla Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const waModal = document.getElementById('waModal');
      if (waModal && waModal.classList.contains('active')) {
        closeWaModal();
      }
    }
  });

  // Procesar envío del formulario rápido de WhatsApp
  if (quickForm) {
    quickForm.addEventListener('submit', (e) => {
      e.preventDefault();
      window.submitWaQuickForm(e);
    });
  }
}

