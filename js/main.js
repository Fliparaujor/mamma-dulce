/* ==========================================================================
   Mamma Dulce · interações
   GSAP + ScrollTrigger + SplitText para as animações, Lenis para a rolagem
   suave. Sem dependência de servidor: tudo roda no GitHub Pages.
   ========================================================================== */
(() => {
  const d = document.documentElement;
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];
  const WHATSAPP = '5527997236993';

  const year = $('#year');
  if (year) year.textContent = new Date().getFullYear();

  const hasGSAP = !!(window.gsap && window.ScrollTrigger && window.SplitText);
  const motion = hasGSAP && d.classList.contains('motion');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

  if (!motion) d.classList.remove('motion');
  if (!hasGSAP) {
    d.classList.add('ready', 'intro-done');
    basics(null);
    return;
  }

  gsap.registerPlugin(ScrollTrigger, SplitText);
  ScrollTrigger.config({ ignoreMobileResize: true });
  gsap.defaults({ ease: 'expo.out', duration: 1.1 });

  /* ---------- rolagem suave ---------- */
  let lenis = null;
  let creationsST = null;
  if (motion && window.Lenis) {
    lenis = new Lenis({ lerp: 0.085, wheelMultiplier: 0.9, anchors: false });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(t => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const startHash = location.hash;
  window.scrollTo(0, 0);

  basics(lenis);

  const fontsReady = Promise.race([
    document.fonts ? document.fonts.ready : Promise.resolve(),
    new Promise(r => setTimeout(r, 2500))
  ]);

  fontsReady.then(() => {
    if (!motion) {
      d.classList.add('ready', 'intro-done');
      railNative();
      return;
    }
    const buildHeroIntro = setupHero();
    setupManifesto();
    setupCurved();
    setupCreations();
    setupReveals();
    setupEssence();
    setupFlavorFloat();
    setupStack();
    setupGallery();
    setupOrder();
    setupFooter();
    setupHeader();
    if (finePointer) { setupMagnetic(); setupCursor(); }
    ScrollTrigger.refresh();
    d.classList.add('ready');
    runIntro(buildHeroIntro());
  });

  /* ======================================================================
     Abertura: a logo se desenha, o nome sobe e a cortina abre.
     ====================================================================== */
  function runIntro(heroTl) {
    const seen = d.classList.contains('intro-seen');
    lenis && lenis.stop();

    const word = SplitText.create('.preloader-word', { type: 'chars', mask: 'chars' });
    const tl = gsap.timeline({
      onComplete() {
        d.classList.add('intro-done');
        word.revert();
        lenis && lenis.start();
        try { sessionStorage.setItem('md-intro', '1'); } catch (e) {}
        if (startHash && startHash.length > 1) goTo(startHash, true);
      }
    });

    if (!seen) {
      const paths = $$('.preloader-logo path');
      paths.forEach(p => {
        const len = p.getTotalLength();
        gsap.set(p, { strokeDasharray: len, strokeDashoffset: len });
      });
      tl.to(paths, { strokeDashoffset: 0, duration: 1.7, ease: 'power2.inOut', stagger: 0.25 })
        .to(paths, { fillOpacity: 1, strokeOpacity: 0, duration: 0.6, ease: 'power1.out' }, '-=0.45')
        .from(word.chars, { yPercent: 115, duration: 0.9, stagger: 0.035 }, '-=0.55')
        .from('.preloader-sub', { autoAlpha: 0, y: 12, duration: 0.8 }, '<0.25')
        .to({}, { duration: 0.35 });
    } else {
      tl.from(word.chars, { yPercent: 115, duration: 0.7, stagger: 0.025 }).to({}, { duration: 0.1 });
    }

    tl.to('.preloader-panel', { yPercent: -100, duration: 1.1, ease: 'expo.inOut' })
      .to('.preloader-layer--rose', { yPercent: -100, duration: 1.1, ease: 'expo.inOut' }, '<0.14')
      .add(() => heroTl.play(), '<0.45');
  }

  /* ======================================================================
     Hero: título linha a linha e foto que cresce até ocupar a tela.
     (adaptação do ScrollExpand e do SplitText do React Bits)
     ====================================================================== */
  function setupHero() {
    const pin = $('.hero-pin');
    const slot = $('.hero-slot');
    const media = $('.hero-media');
    const img = $('img', media);
    const copy = $('.hero-copy');
    const badge = $('.hero-badge');

    const box = () => {
      const p = pin.getBoundingClientRect();
      const r = slot.getBoundingClientRect();
      return { x: r.left - p.left, y: r.top - p.top, w: r.width, h: r.height, W: p.width, H: p.height };
    };
    let g = box();
    const placeBadge = () => {
      const s = badge.offsetWidth;
      const narrow = g.x < s;
      gsap.set(badge, {
        left: narrow ? g.x + g.w - s * 0.72 : g.x - s * 0.42,
        top: narrow ? g.y - s * 0.38 : g.y + g.h - s * 0.78,
        right: 'auto', bottom: 'auto'
      });
    };
    placeBadge();
    ScrollTrigger.addEventListener('refreshInit', () => {
      g = box();
      placeBadge();
    });

    const scroll = gsap.timeline({
      defaults: { ease: 'none', duration: 1 },
      scrollTrigger: {
        trigger: '.hero',
        start: 'top top',
        end: '+=120%',
        pin: pin,
        scrub: 0.8,
        invalidateOnRefresh: true
      }
    });
    scroll
      .fromTo(media,
        { left: () => g.x, top: () => g.y, width: () => g.w, height: () => g.h, borderRadius: 10 },
        { left: 0, top: 0, width: () => g.W, height: () => g.H, borderRadius: 0, ease: 'power2.inOut' }, 0)
      .fromTo(img, { scale: 1.12 }, { scale: 1, ease: 'power1.out' }, 0)
      .to(copy, { autoAlpha: 0, y: -80, duration: 0.45 }, 0)
      .to(badge, { autoAlpha: 0, scale: 0.6, rotate: 40, duration: 0.3 }, 0)
      .to('.scroll-cue', { autoAlpha: 0, duration: 0.15 }, 0)
      .to('.hero-scrim', { opacity: 1, duration: 0.45 }, 0.4)
      .fromTo('.hero-overlay', { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: 0.35 }, 0.65);

    return () => {
      const title = SplitText.create('.hero-title', { type: 'lines', mask: 'lines', linesClass: 'split-line' });
      const intro = gsap.timeline({ paused: true, onComplete: () => title.revert() });
      intro
        .fromTo(media, { clipPath: 'inset(100% 0% 0% 0% round 10px)' },
          { clipPath: 'inset(0% 0% 0% 0% round 10px)', duration: 1.6, ease: 'expo.inOut', clearProps: 'clipPath' }, 0)
        .from(img, { scale: 1.4, duration: 2.2, ease: 'expo.out' }, 0.2)
        .from(title.lines, { yPercent: 110, duration: 1.4, stagger: 0.12 }, 0.35)
        .from('.hero-eyebrow', { autoAlpha: 0, y: 16, duration: 1 }, 0.3)
        .from(['.hero-lead', '.hero-actions'], { autoAlpha: 0, y: 26, duration: 1.2, stagger: 0.1 }, 0.75)
        .from('.header', { yPercent: -100, autoAlpha: 0, duration: 1.2 }, 0.6)
        .from(badge, { scale: 0, rotate: -120, duration: 1.4 }, 0.9)
        .from('.scroll-cue', { autoAlpha: 0, duration: 1 }, 1.1);
      return intro;
    };
  }

  /* ======================================================================
     Cabeçalho: fundo ao rolar, barra de leitura e indicador da seção ativa.
     (padrão Motion Navigation do Unlumen)
     ====================================================================== */
  function setupHeader() {
    const header = $('#header');
    const nav = $('.nav');
    const indicator = $('.nav-indicator');
    const links = $$('.nav a');
    let active = null;

    ScrollTrigger.create({
      start: 0, end: 'max',
      onUpdate(self) {
        header.classList.toggle('is-scrolled', self.scroll() > 30);
        gsap.set('.header-progress span', { scaleX: self.progress });
      }
    });

    const moveTo = a => {
      if (!a) { indicator.style.opacity = 0; return; }
      indicator.style.opacity = 1;
      indicator.style.width = a.offsetWidth + 'px';
      indicator.style.transform = `translateX(${a.offsetLeft}px)`;
    };
    const setActive = a => {
      active = a;
      links.forEach(l => l.classList.toggle('is-active', l === a));
      moveTo(a);
    };
    links.forEach(a => {
      const sec = $(a.getAttribute('href'));
      if (!sec) return;
      ScrollTrigger.create({
        trigger: sec, start: 'top 45%', end: 'bottom 45%',
        onToggle: self => {
          if (self.isActive) setActive(a);
          else if (active === a) setActive(null);
        }
      });
      a.addEventListener('mouseenter', () => moveTo(a));
      a.addEventListener('focus', () => moveTo(a));
    });
    nav.addEventListener('mouseleave', () => moveTo(active));
    window.addEventListener('resize', () => moveTo(active));
  }

  /* ======================================================================
     Manifesto: palavras acendem conforme a rolagem (ScrollReveal, React Bits)
     ====================================================================== */
  function setupManifesto() {
    const el = $('[data-scroll-text]');
    if (!el) return;
    const split = SplitText.create(el, { type: 'words' });
    gsap.fromTo(split.words, { opacity: 0.13 }, {
      opacity: 1, stagger: 0.06, ease: 'none',
      scrollTrigger: { trigger: el, start: 'top 82%', end: 'bottom 52%', scrub: 0.6 }
    });
    $$('.pill-img', el).forEach(p => {
      gsap.fromTo(p, { scale: 0.2, autoAlpha: 0 }, {
        scale: 1, autoAlpha: 1, ease: 'back.out(1.6)', duration: 1,
        scrollTrigger: { trigger: p, start: 'top 82%', toggleActions: 'play none none reverse' }
      });
    });
  }

  /* ======================================================================
     Faixa em curva com velocidade ligada à rolagem (CurvedLoop + ScrollVelocity)
     ====================================================================== */
  function setupCurved() {
    const wrap = $('.curved');
    const textPath = $('.curved textPath');
    const tspan = $('tspan', textPath);
    const path = $('#curved-path');
    if (!wrap || !textPath) return;

    const unitText = tspan.textContent;
    const unit = tspan.getComputedTextLength();
    if (!unit) return;
    const copies = Math.ceil(path.getTotalLength() / unit) + 2;
    tspan.textContent = unitText.repeat(copies);

    let offset = -unit * 0.4;
    let dir = 1;
    let visible = false;
    ScrollTrigger.create({ trigger: wrap, start: 'top bottom', end: 'bottom top', onToggle: s => (visible = s.isActive) });

    gsap.ticker.add((time, delta) => {
      if (!visible) return;
      const v = lenis ? lenis.velocity : 0;
      if (Math.abs(v) > 0.3) dir = v > 0 ? 1 : -1;
      const speed = (0.045 + Math.min(Math.abs(v), 60) * 0.012) * delta;
      offset -= speed * dir;
      if (offset <= -unit) offset += unit;
      if (offset > 0) offset -= unit;
      textPath.setAttribute('startOffset', offset.toFixed(2));
    });
  }

  /* ======================================================================
     Criações: trilho horizontal preso à tela no computador,
     deslize nativo no celular.
     ====================================================================== */
  function setupCreations() {
    const mm = gsap.matchMedia();
    mm.add('(min-width: 981px)', () => {
      const rail = $('#creations-rail');
      const track = $('.rail-track');
      const bar = $('.rail-bar span');
      const head = $('.creations-head');
      const headHome = head.parentNode;
      track.prepend(head);
      rail.style.overflow = 'visible';
      rail.style.scrollSnapType = 'none';

      const dist = () => Math.max(0, track.scrollWidth - window.innerWidth);
      const move = gsap.to(track, { x: () => -dist(), ease: 'none' });
      const st = creationsST = ScrollTrigger.create({
        trigger: '.creations-pin',
        start: 'top top',
        end: () => '+=' + dist(),
        pin: true,
        scrub: 0.9,
        animation: move,
        invalidateOnRefresh: true,
        onUpdate: self => {
          gsap.set(bar, { scaleX: self.progress });
          setArrows(self.progress);
        }
      });

      $$('.card-media img', track).forEach(img => {
        gsap.fromTo(img, { xPercent: -5 }, {
          xPercent: 5, ease: 'none',
          scrollTrigger: { trigger: img.parentElement, containerAnimation: move, start: 'left right', end: 'right left', scrub: true }
        });
      });
      // os cards que já cabem na tela entram com a rolagem vertical;
      // os demais entram conforme o trilho anda para o lado
      const firstView = $$('.card', track).filter(c => c.offsetLeft < window.innerWidth * 0.94);
      gsap.from(firstView, {
        y: 70, rotate: 2, autoAlpha: 0, duration: 1.3, stagger: 0.1,
        scrollTrigger: { trigger: '.creations-pin', start: 'top 62%', toggleActions: 'play none none reverse' }
      });
      $$('.card', track).filter(c => !firstView.includes(c)).forEach(card => {
        gsap.from(card, {
          y: 60, rotate: 2, autoAlpha: 0, duration: 1.2,
          scrollTrigger: { trigger: card, containerAnimation: move, start: 'left 96%', toggleActions: 'play none none reverse' }
        });
      });

      const cards = $$('.card', track);
      const step = dir => {
        const x = -gsap.getProperty(track, 'x');
        const pad = parseFloat(getComputedStyle(track).paddingLeft) || 0;
        const lefts = [0, ...cards.map(c => c.offsetLeft - pad)];
        let target = dir > 0 ? lefts.find(l => l > x + 8) : [...lefts].reverse().find(l => l < x - 8);
        if (target === undefined) target = dir > 0 ? dist() : 0;
        target = Math.min(target, dist());
        const y = st.start + (target / dist()) * (st.end - st.start);
        lenis ? lenis.scrollTo(y, { duration: 1.2 }) : window.scrollTo({ top: y, behavior: 'smooth' });
      };
      const prev = $('[data-rail="prev"]');
      const next = $('[data-rail="next"]');
      const onPrev = () => step(-1);
      const onNext = () => step(1);
      prev.addEventListener('click', onPrev);
      next.addEventListener('click', onNext);
      setArrows(0);
      return () => {
        creationsST = null;
        headHome.insertBefore(head, rail);
        rail.style.overflow = '';
        rail.style.scrollSnapType = '';
        prev.removeEventListener('click', onPrev);
        next.removeEventListener('click', onNext);
      };
    });
    mm.add('(max-width: 980px)', () => railNative());
  }

  function setArrows(p) {
    const prev = $('[data-rail="prev"]');
    const next = $('[data-rail="next"]');
    if (prev) prev.disabled = p < 0.01;
    if (next) next.disabled = p > 0.99;
  }

  function railNative() {
    const rail = $('#creations-rail');
    const bar = $('.rail-bar span');
    const prev = $('[data-rail="prev"]');
    const next = $('[data-rail="next"]');
    if (!rail) return;
    const update = () => {
      const max = rail.scrollWidth - rail.clientWidth;
      const p = max > 0 ? rail.scrollLeft / max : 0;
      bar.style.transform = `scaleX(${Math.max(p, 0.04)})`;
      setArrows(p);
    };
    const by = dir => {
      const card = $('.card', rail);
      rail.scrollBy({ left: dir * (card.offsetWidth + 18), behavior: 'smooth' });
    };
    const onPrev = () => by(-1);
    const onNext = () => by(1);
    rail.addEventListener('scroll', update, { passive: true });
    prev.addEventListener('click', onPrev);
    next.addEventListener('click', onNext);
    update();
    return () => {
      rail.removeEventListener('scroll', update);
      prev.removeEventListener('click', onPrev);
      next.removeEventListener('click', onNext);
    };
  }

  /* ======================================================================
     Revelações gerais: títulos linha a linha, blocos que sobem,
     fotos que abrem por recorte.
     ====================================================================== */
  function setupReveals() {
    $$('[data-split]').forEach(el => {
      const chars = el.dataset.split === 'chars';
      const split = SplitText.create(el, {
        type: chars ? 'lines,chars' : 'lines',
        mask: 'lines',
        linesClass: 'split-line'
      });
      gsap.from(chars ? split.chars : split.lines, {
        yPercent: 115,
        rotate: chars ? 6 : 0,
        duration: chars ? 1.2 : 1.4,
        stagger: chars ? 0.022 : 0.12,
        scrollTrigger: { trigger: el, start: 'top 86%', once: true },
        onComplete: () => split.revert()
      });
    });

    ScrollTrigger.batch('[data-reveal]', {
      start: 'top 90%',
      once: true,
      onEnter: batch => gsap.to(batch, { autoAlpha: 1, y: 0, duration: 1.2, stagger: 0.09, overwrite: true })
    });

    $$('[data-clip]').forEach(el => {
      gsap.fromTo(el,
        { clipPath: 'inset(14% 12% 14% 12% round 10px)' },
        { clipPath: 'inset(0% 0% 0% 0% round 10px)', ease: 'power2.out', scrollTrigger: { trigger: el, start: 'top 92%', end: 'top 40%', scrub: 0.6 } });
    });

    $$('[data-parallax]').forEach(img => {
      const amt = parseFloat(img.dataset.parallax) || 10;
      gsap.fromTo(img, { yPercent: -amt / 2 }, {
        yPercent: amt / 2, ease: 'none',
        scrollTrigger: { trigger: img.parentElement, start: 'top bottom', end: 'bottom top', scrub: true }
      });
    });

    $$('[data-speed]').forEach(el => {
      const s = parseFloat(el.dataset.speed) || 0;
      gsap.fromTo(el, { y: -s * 300 }, {
        y: s * 300, ease: 'none',
        scrollTrigger: { trigger: el.parentElement, start: 'top bottom', end: 'bottom top', scrub: true }
      });
    });
  }

  function setupEssence() {
    gsap.fromTo('.signature', { clipPath: 'inset(-20% 100% -20% 0%)' }, {
      clipPath: 'inset(-20% 0% -20% 0%)', duration: 2.2, ease: 'power2.inOut',
      scrollTrigger: { trigger: '.signature', start: 'top 92%', once: true }
    });
  }

  /* ======================================================================
     Sabores: foto que acompanha o cursor (Image Reveal, Skiper UI)
     ====================================================================== */
  function setupFlavorFloat() {
    if (!finePointer) return;
    const float = $('.flavor-float');
    const inner = $('.flavor-float-inner');
    const list = $('.flavor-list');
    const items = $$('.flavor');
    const imgs = items.map(li => {
      const im = new Image();
      im.src = li.dataset.img;
      im.alt = '';
      im.decoding = 'async';
      inner.appendChild(im);
      return im;
    });
    const xTo = gsap.quickTo(float, 'x', { duration: 0.7, ease: 'power3' });
    const yTo = gsap.quickTo(float, 'y', { duration: 0.7, ease: 'power3' });
    const rTo = gsap.quickTo(float, 'rotate', { duration: 0.9, ease: 'power3' });
    let lastX = 0;
    let shown = false;

    const show = on => {
      if (on === shown) return;
      shown = on;
      gsap.to(float, { autoAlpha: on ? 1 : 0, scale: on ? 1 : 0.6, duration: on ? 0.6 : 0.4, ease: on ? 'expo.out' : 'power2.in', overwrite: 'auto' });
    };
    const place = e => {
      const w = float.offsetWidth;
      const h = float.offsetHeight;
      let x = e.clientX + 36;
      if (x + w > window.innerWidth - 16) x = e.clientX - w - 36;
      xTo(x);
      yTo(e.clientY - h / 2);
      rTo(gsap.utils.clamp(-10, 10, (e.clientX - lastX) * 0.6));
      lastX = e.clientX;
    };

    items.forEach((li, i) => {
      const btn = $('.flavor-btn', li);
      btn.addEventListener('pointerenter', e => {
        if (btn.getAttribute('aria-expanded') === 'true') { show(false); return; }
        imgs.forEach((im, j) => im.classList.toggle('is-on', j === i));
        if (!shown) {
          const w = float.offsetWidth;
          gsap.set(float, { x: e.clientX + w > window.innerWidth - 16 ? e.clientX - w - 36 : e.clientX + 36, y: e.clientY - float.offsetHeight / 2 });
        }
        show(true);
      });
      btn.addEventListener('click', () => show(false));
    });
    list.addEventListener('pointermove', place);
    list.addEventListener('pointerleave', () => show(false));
  }

  /* ======================================================================
     Processo: cartões que se empilham (ScrollStack, React Bits)
     ====================================================================== */
  function setupStack() {
    const cards = $$('.stack-card');
    cards.forEach((card, i) => {
      card.style.top = `calc(var(--header) + ${18 + i * 16}px)`;
      const next = cards[i + 1];
      if (!next) return;
      gsap.to(card, {
        scale: 0.93 - (cards.length - 2 - i) * 0.02,
        ease: 'none',
        scrollTrigger: { trigger: next, start: 'top bottom', end: 'top 25%', scrub: true }
      });
      gsap.to($('.stack-img img', card), {
        scale: 1.12, ease: 'none',
        scrollTrigger: { trigger: next, start: 'top bottom', end: 'top 25%', scrub: true }
      });
    });
  }

  /* ======================================================================
     Galeria: colunas em velocidades diferentes.
     ====================================================================== */
  function setupGallery() {
    // cada coluna sobe num ritmo diferente; nenhuma começa acima do título
    const k = window.innerWidth < 720 ? 0.5 : 1;
    $$('[data-col-speed]').forEach(col => {
      const [from, to] = col.dataset.colSpeed.split(',').map(Number);
      gsap.fromTo(col, { y: from * k }, {
        y: to * k, ease: 'none',
        scrollTrigger: { trigger: '.masonry', start: 'top bottom', end: 'bottom top', scrub: true }
      });
    });
    ScrollTrigger.batch('.tile', {
      start: 'top 94%', once: true,
      onEnter: batch => gsap.fromTo(batch,
        { clipPath: 'inset(100% 0% 0% 0% round 10px)' },
        { clipPath: 'inset(0% 0% 0% 0% round 10px)', duration: 1.4, ease: 'expo.inOut', stagger: 0.12 })
    });
  }

  /* ======================================================================
     Encomendas: rastro de fotos atrás do cursor (ImageTrail, React Bits)
     ====================================================================== */
  function setupOrder() {
    if (!finePointer) return;
    const section = $('.order');
    const layer = $('.order-trail');
    const srcs = ['floral', 'pink-bow', 'chocolate', 'hero', 'botanical', 'gift', 'pistache', 'wedding', 'lotus', 'flowers', 'easter', 'chocolate-fruit'];
    const pool = srcs.map(n => {
      const im = new Image();
      im.alt = '';
      im.decoding = 'async';
      im.dataset.src = `assets/${n}-sm.webp`;
      layer.appendChild(im);
      return im;
    });
    let loaded = false;
    let idx = 0;
    let z = 1;
    let last = null;

    section.addEventListener('pointerenter', () => {
      if (loaded) return;
      loaded = true;
      pool.forEach(im => (im.src = im.dataset.src));
    });
    section.addEventListener('pointermove', e => {
      if (e.target.closest('button, a')) return;
      const r = section.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (last && Math.hypot(x - last.x, y - last.y) < 110) return;
      const im = pool[idx++ % pool.length];
      const w = im.offsetWidth || 180;
      const h = im.offsetHeight || 240;
      const from = last || { x, y };
      last = { x, y };
      gsap.killTweensOf(im);
      im.style.zIndex = ++z;
      gsap.timeline()
        .fromTo(im,
          { x: from.x - w / 2, y: from.y - h / 2, opacity: 1, scale: 0.5, rotate: gsap.utils.random(-14, 14) },
          { x: x - w / 2, y: y - h / 2, scale: 1, rotate: gsap.utils.random(-6, 6), duration: 0.8, ease: 'expo.out' })
        .to(im, { opacity: 0, scale: 0.8, y: '+=40', duration: 0.7, ease: 'power2.in' }, 0.65);
    });
  }

  function setupFooter() {
    const el = $('.footer-word');
    // o nome ocupa exatamente a largura do rodapé
    const fit = () => {
      el.style.fontSize = '';
      const box = el.parentElement.clientWidth - parseFloat(getComputedStyle(el.parentElement).paddingLeft) * 2;
      const size = parseFloat(getComputedStyle(el).fontSize);
      el.style.fontSize = Math.min(size * (box / el.scrollWidth), 340) + 'px';
    };
    fit();
    window.addEventListener('resize', fit);
    const split = SplitText.create(el, { type: 'chars', mask: 'chars' });
    gsap.from(split.chars, {
      yPercent: 105, duration: 1.4, stagger: 0.045,
      scrollTrigger: { trigger: el, start: 'top 98%', once: true },
      onComplete: () => split.revert()
    });
  }

  /* ======================================================================
     Botões magnéticos (MicroKit Magnetic Fill) e cursor com legenda.
     ====================================================================== */
  function setupMagnetic() {
    $$('[data-magnetic]').forEach(el => {
      const xTo = gsap.quickTo(el, 'x', { duration: 0.8, ease: 'elastic.out(1, 0.4)' });
      const yTo = gsap.quickTo(el, 'y', { duration: 0.8, ease: 'elastic.out(1, 0.4)' });
      el.addEventListener('pointermove', e => {
        const r = el.getBoundingClientRect();
        xTo((e.clientX - (r.left + r.width / 2)) * 0.28);
        yTo((e.clientY - (r.top + r.height / 2)) * 0.38);
      });
      el.addEventListener('pointerleave', () => { xTo(0); yTo(0); });
    });
  }

  function setupCursor() {
    const cursor = $('.cursor');
    const label = $('.cursor-label');
    d.classList.add('has-cursor');
    const xTo = gsap.quickTo(cursor, 'x', { duration: 0.45, ease: 'power3' });
    const yTo = gsap.quickTo(cursor, 'y', { duration: 0.45, ease: 'power3' });
    let on = false;
    window.addEventListener('pointermove', e => { xTo(e.clientX); yTo(e.clientY); }, { passive: true });
    $$('[data-cursor]').forEach(el => {
      el.addEventListener('pointerenter', e => {
        label.textContent = el.dataset.cursor;
        if (!on) gsap.set(cursor, { x: e.clientX, y: e.clientY });
        on = true;
        gsap.to(cursor, { scale: 1, opacity: 1, duration: 0.5, overwrite: 'auto' });
      });
      el.addEventListener('pointerleave', () => {
        on = false;
        gsap.to(cursor, { scale: 0, opacity: 0, duration: 0.35, ease: 'power2.in', overwrite: 'auto' });
      });
    });
  }

  /* ======================================================================
     Tudo o que precisa funcionar mesmo sem animação: âncoras, menu,
     sabores, galeria ampliada e o formulário do WhatsApp.
     ====================================================================== */
  function goTo(hash, instant) {
    let target = hash === '#inicio' ? 0 : $(hash);
    if (target === null) return;
    // a seção de criações fica presa à tela: o destino é o início dessa trava
    if (hash === '#criacoes' && creationsST) target = creationsST.start + 1;
    if (lenis) lenis.scrollTo(target, { duration: instant ? 0 : 1.5, immediate: !!instant, offset: 0 });
    else if (target === 0) window.scrollTo({ top: 0, behavior: instant ? 'auto' : 'smooth' });
    else target.scrollIntoView({ behavior: instant ? 'auto' : 'smooth' });
  }

  function basics(lenis) {
    /* âncoras */
    document.addEventListener('click', e => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      const hash = a.getAttribute('href');
      if (hash.length < 2) return;
      if (hash !== '#inicio' && !$(hash)) return;
      e.preventDefault();
      if (d.classList.contains('menu-open')) toggleMenu(false);
      goTo(hash);
      if (hash === '#principal') $('#principal').focus({ preventScroll: true });
    });

    /* menu do celular (StaggeredMenu, React Bits) */
    const toggle = $('.menu-toggle');
    const menu = $('#menu');
    let menuTl = null;
    if (window.gsap) gsap.set($$('.menu-layer, .menu-panel', menu), { x: 0, xPercent: 100 });
    function toggleMenu(open) {
      d.classList.toggle('menu-open', open);
      toggle.setAttribute('aria-expanded', open);
      toggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
      menu.setAttribute('aria-hidden', !open);
      menu.inert = !open;
      if (open) lenis && lenis.stop(); else lenis && lenis.start();
      if (window.gsap) {
        menuTl && menuTl.kill();
        const layers = $$('.menu-layer, .menu-panel', menu);
        const links = $$('.menu-links span, .menu-links small', menu);
        menuTl = open
          ? gsap.timeline()
              .fromTo(layers, { xPercent: 100 }, { xPercent: 0, duration: 0.8, stagger: 0.08, ease: 'expo.inOut' })
              .fromTo(links, { yPercent: 120 }, { yPercent: 0, duration: 0.9, stagger: 0.04 }, '-=0.4')
              .fromTo('.menu-foot', { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.6 }, '-=0.6')
          : gsap.timeline().to([...layers].reverse(), { xPercent: 100, duration: 0.6, stagger: 0.06, ease: 'expo.inOut' });
      }
      if (open) setTimeout(() => $('.menu-links a', menu).focus({ preventScroll: true }), 300);
    }
    toggle.addEventListener('click', () => toggleMenu(!d.classList.contains('menu-open')));
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && d.classList.contains('menu-open')) { toggleMenu(false); toggle.focus(); }
    });
    matchMedia('(min-width: 981px)').addEventListener('change', e => { if (e.matches && d.classList.contains('menu-open')) toggleMenu(false); });

    /* sabores */
    $$('.flavor-btn').forEach(btn => {
      const panel = $('#' + btn.getAttribute('aria-controls'));
      btn.addEventListener('click', () => {
        const open = btn.getAttribute('aria-expanded') !== 'true';
        $$('.flavor-btn[aria-expanded="true"]').forEach(other => { if (other !== btn) setFlavor(other, false); });
        setFlavor(btn, open);
      });
      function setFlavorInner(open) {
        btn.setAttribute('aria-expanded', open);
        if (!window.gsap || !d.classList.contains('motion')) { panel.hidden = !open; return; }
        gsap.killTweensOf(panel);
        if (open) {
          panel.hidden = false;
          gsap.fromTo(panel, { height: 0 }, { height: 'auto', duration: 0.8, ease: 'expo.out', onComplete: refresh });
          gsap.fromTo($$('img, p', panel), { autoAlpha: 0, y: 20 }, { autoAlpha: 1, y: 0, duration: 0.9, stagger: 0.08, delay: 0.1 });
        } else {
          gsap.to(panel, { height: 0, duration: 0.55, ease: 'power3.inOut', onComplete: () => { panel.hidden = true; gsap.set(panel, { clearProps: 'height' }); refresh(); } });
        }
      }
      btn._setFlavor = setFlavorInner;
    });
    function setFlavor(btn, open) { btn._setFlavor(open); }
    let refreshTimer;
    function refresh() {
      if (!window.ScrollTrigger) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => ScrollTrigger.refresh(), 60);
    }

    /* foto ampliada */
    const lb = $('.lightbox');
    const lbImg = $('.lightbox-img');
    const lbCap = $('.lightbox-cap');
    const lbCount = $('.lightbox-count');
    let group = [];
    let at = 0;
    const pad = n => String(n).padStart(2, '0');
    function show(i, dir = 0) {
      at = (i + group.length) % group.length;
      const item = group[at];
      const thumb = $('img', item);
      const swap = () => {
        lbImg.src = item.dataset.full || thumb.currentSrc || thumb.src;
        lbImg.alt = thumb.alt;
        lbCap.textContent = item.dataset.caption || '';
        lbCount.textContent = `${pad(at + 1)} / ${pad(group.length)}`;
      };
      if (window.gsap && dir && d.classList.contains('motion')) {
        gsap.timeline()
          .to(lbImg, { autoAlpha: 0, x: -30 * dir, duration: 0.25, ease: 'power2.in', onComplete: swap })
          .fromTo(lbImg, { x: 30 * dir }, { autoAlpha: 1, x: 0, duration: 0.6 });
      } else swap();
    }
    $$('[data-lightbox]').forEach(item => {
      item.addEventListener('click', () => {
        group = $$(`[data-lightbox="${item.dataset.lightbox}"]`).filter(el => el.offsetParent !== null);
        if (!group.includes(item)) group.push(item);
        show(group.indexOf(item));
        lb.showModal();
        lenis && lenis.stop();
        if (window.gsap && d.classList.contains('motion')) gsap.fromTo('.lightbox-fig', { autoAlpha: 0, scale: 0.94 }, { autoAlpha: 1, scale: 1, duration: 0.8 });
      });
    });
    $('[data-lb="prev"]').addEventListener('click', () => show(at - 1, -1));
    $('[data-lb="next"]').addEventListener('click', () => show(at + 1, 1));
    lb.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft') show(at - 1, -1);
      if (e.key === 'ArrowRight') show(at + 1, 1);
    });
    lb.addEventListener('click', e => { if (e.target === lb || e.target.classList.contains('lightbox-fig')) lb.close(); });
    let touchX = null;
    lb.addEventListener('touchstart', e => (touchX = e.touches[0].clientX), { passive: true });
    lb.addEventListener('touchend', e => {
      if (touchX === null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 50) show(at + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
      touchX = null;
    });

    /* conversa no WhatsApp */
    const od = $('.order-dialog');
    $$('[data-open-order]').forEach(b => b.addEventListener('click', () => {
      od.showModal();
      lenis && lenis.stop();
      if (window.gsap && d.classList.contains('motion')) {
        gsap.fromTo(od, { autoAlpha: 0, y: 40, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.8 });
      }
    }));
    od.addEventListener('click', e => { if (e.target === od) od.close(); });

    $$('dialog').forEach(dlg => {
      dlg.setAttribute('data-lenis-prevent', '');
      $('[data-close]', dlg).addEventListener('click', () => dlg.close());
      dlg.addEventListener('close', () => lenis && lenis.start());
    });

    const form = $('#order-form');
    const err = $('#occasion-error');
    form.addEventListener('change', () => { if (form.occasion.value) err.hidden = true; });
    form.addEventListener('submit', e => {
      e.preventDefault();
      const data = new FormData(form);
      const occasion = data.get('occasion');
      if (!occasion) {
        err.hidden = false;
        $('input[name="occasion"]', form).focus();
        return;
      }
      const lines = ['Olá, Jaci! Vim pelo site da Mamma Dulce e quero conversar sobre uma encomenda.', '', `Ocasião: ${occasion}`];
      const date = data.get('date');
      if (date) {
        const [y, m, dd] = date.split('-');
        lines.push(`Data: ${dd}/${m}/${y}`);
      }
      if (data.get('guests')) lines.push(`Pessoas: ${data.get('guests')}`);
      const idea = (data.get('idea') || '').trim();
      if (idea) lines.push(`Minha ideia: ${idea}`);
      lines.push('', 'Podemos pensar em algo especial?');
      const url = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(lines.join('\n'))}`;
      $('#wa-fallback').href = url;
      $('.form-status', form).hidden = false;
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  }
})();
