(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const header = $('#header');
  const progress = $('.reading-progress');
  const photoFrames = $$('[data-photo]');
  const visiblePhotos = new Set();
  photoFrames.forEach(frame => { const img = $('img', frame); if (img) img.draggable = false; });
  let scrollQueued = false;
  function updateScroll() {
    const y = window.scrollY;
    header.classList.toggle('scrolled', y > 30);
    const height = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.transform = `scaleX(${height > 0 ? Math.min(1, y / height) : 0})`;
    if (!reducedMotion) visiblePhotos.forEach(frame => {
      const rect = frame.getBoundingClientRect();
      const offset = Math.max(-12, Math.min(12, (window.innerHeight / 2 - rect.top - rect.height / 2) * .035));
      frame.style.setProperty('--photo-y', `${offset.toFixed(2)}px`);
    });
    scrollQueued = false;
  }
  window.addEventListener('scroll', () => { if (!scrollQueued) { scrollQueued = true; requestAnimationFrame(updateScroll); } }, { passive: true });
  window.addEventListener('resize', updateScroll);
  updateScroll();
  $('#year').textContent = String(new Date().getFullYear());

  if ('IntersectionObserver' in window && !reducedMotion) {
    const photos = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('photo-visible');
        visiblePhotos.add(entry.target);
      } else visiblePhotos.delete(entry.target);
    }), { threshold: .12, rootMargin: '35px' });
    photoFrames.forEach(frame => photos.observe(frame));
  } else photoFrames.forEach(frame => frame.classList.add('photo-visible'));

  if ('IntersectionObserver' in window && !reducedMotion) {
    document.documentElement.classList.add('motion');
    const reveal = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('visible'); reveal.unobserve(entry.target); }
    }), { threshold: .08, rootMargin: '0px 0px -20px 0px' });
    $$('.reveal').forEach(el => reveal.observe(el));
  }
  if ('IntersectionObserver' in window) {
    const sections = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          $$('.desktop-nav a').forEach(link => {
            if (link.hash === `#${entry.target.id}`) link.setAttribute('aria-current', 'location');
            else link.removeAttribute('aria-current');
          });
        }
      });
    }, { rootMargin: '-15% 0px -65% 0px', threshold: 0 });
    $$('main section[id]').forEach(section => sections.observe(section));
  }
  const menu = $('.menu-toggle');
  const mobileNav = $('#mobile-nav');
  function closeMenu() { menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-label', 'Abrir menu'); mobileNav.hidden = true; }
  menu.addEventListener('click', () => {
    const open = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(open)); menu.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu'); mobileNav.hidden = !open;
  });
  $$('.mobile-nav a').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !mobileNav.hidden) { closeMenu(); menu.focus(); } });
  document.addEventListener('click', event => { if (!header.contains(event.target)) closeMenu(); });
  window.matchMedia('(min-width: 801px)').addEventListener('change', event => { if (event.matches) closeMenu(); });

  const railManagers = new Map();
  $$('.photo-rail').forEach(rail => {
    const footer = rail.nextElementSibling;
    const previous = $('[data-rail-prev]', footer);
    const next = $('[data-rail-next]', footer);
    const count = $('[data-rail-count]', footer);
    const bar = $('.rail-progress', footer);
    let pointer = null;
    let suppressClick = false;
    let scrollFrame = 0;
    const cards = () => [...rail.children].filter(card => !card.hidden);
    const maxScroll = () => Math.max(0, rail.scrollWidth - rail.clientWidth);
    const step = () => (cards()[0]?.getBoundingClientRect().width || 300) + parseFloat(getComputedStyle(rail).gap || 0);
    const behavior = reducedMotion ? 'instant' : 'smooth';
    function updateRail() {
      scrollFrame = 0;
      const items = cards();
      const max = maxScroll();
      previous.disabled = rail.scrollLeft < 3;
      next.disabled = rail.scrollLeft > max - 3 || max < 3;
      const index = Math.min(items.length, Math.round(rail.scrollLeft / step()) + 1);
      count.textContent = `${String(index).padStart(2, '0')} / ${String(items.length).padStart(2, '0')}`;
      bar.style.setProperty('--rail-progress', String(max > 0 ? Math.min(1, (rail.scrollLeft + rail.clientWidth) / rail.scrollWidth) : 1));
      updateScroll();
    }
    rail.addEventListener('scroll', () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateRail); }, { passive: true });
    previous.addEventListener('click', () => rail.scrollBy({ left: -step(), behavior }));
    next.addEventListener('click', () => rail.scrollBy({ left: step(), behavior }));
    rail.addEventListener('keydown', event => {
      if (event.target !== rail) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault(); rail.scrollBy({ left: step() * (event.key === 'ArrowRight' ? 1 : -1), behavior });
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); rail.scrollTo({ left: event.key === 'Home' ? 0 : maxScroll(), behavior });
      }
    });
    rail.addEventListener('wheel', event => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 18 : 1);
      if ((delta > 0 && rail.scrollLeft < maxScroll() - 2) || (delta < 0 && rail.scrollLeft > 2)) {
        event.preventDefault(); rail.scrollBy({ left: delta * 1.35, behavior });
      }
    }, { passive: false });
    rail.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      pointer = { id: event.pointerId, x: event.clientX, left: rail.scrollLeft, lastX: event.clientX, time: performance.now(), velocity: 0, moved: false };
    });
    rail.addEventListener('pointermove', event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const distance = event.clientX - pointer.x;
      if (!pointer.moved && Math.abs(distance) < 6) return;
      if (!pointer.moved) { pointer.moved = true; rail.classList.add('is-dragging'); rail.setPointerCapture(event.pointerId); }
      const now = performance.now();
      pointer.velocity = (event.clientX - pointer.lastX) / Math.max(1, now - pointer.time);
      pointer.lastX = event.clientX; pointer.time = now;
      rail.scrollLeft = pointer.left - distance;
    });
    function endDrag(event) {
      if (!pointer || pointer.id !== event.pointerId) return;
      const dragged = pointer.moved;
      const velocity = performance.now() - pointer.time < 90 ? Math.max(-2, Math.min(2, pointer.velocity)) : 0;
      pointer = null;
      rail.classList.remove('is-dragging');
      if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
      if (dragged) {
        suppressClick = true;
        rail.scrollTo({ left: Math.max(0, Math.min(maxScroll(), rail.scrollLeft - velocity * 160)), behavior });
        setTimeout(() => { suppressClick = false; }, 0);
      }
    }
    rail.addEventListener('pointerup', endDrag);
    rail.addEventListener('pointercancel', endDrag);
    window.addEventListener('pointerup', endDrag);
    rail.addEventListener('click', event => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    const manager = { refresh() { rail.scrollTo({ left: 0, behavior: 'instant' }); requestAnimationFrame(updateRail); } };
    railManagers.set(rail.id, manager);
    if ('ResizeObserver' in window) new ResizeObserver(updateRail).observe(rail);
    updateRail();
  });

  $$('[data-filter]').forEach(button => button.addEventListener('click', () => {
    const filter = button.dataset.filter;
    $$('[data-filter]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
    $$('.creation').forEach(card => {
      card.hidden = filter !== 'all' && card.dataset.category !== filter;
      if (!card.hidden) card.classList.add('visible');
    });
    railManagers.get('creations-grid')?.refresh();
    updateScroll();
  }));

  const flavorImage = $('#flavor-image');
  $$('.flavor').forEach(details => details.addEventListener('toggle', () => {
    if (!details.open) return;
    flavorImage.src = `assets/${details.dataset.image}.webp`;
    flavorImage.alt = details.dataset.alt;
    flavorImage.classList.toggle('menu-image', details.dataset.image.includes('menu') || details.dataset.image === 'franoa');
    if (!reducedMotion) flavorImage.animate([{ opacity: .1 }, { opacity: 1 }], { duration: 600, easing: 'ease-out' });
  }));

  const gallery = {
    floral: ['Flores para celebrar', 'Bolo com flores de arroz em rosa, lavanda e branco'],
    wedding: ['O começo de uma nova história', 'Bolo de casamento branco com decoração floral'],
    gift: ['Um carinho que vem embrulhado', 'Ovos de Páscoa embrulhados em tecido listrado'],
    'pink-bow': ['Encanto em forma de laço', 'Bolo rosa com um grande laço e pérolas'],
    botanical: ['Um jardim de motivos', 'Bolo com flores coloridas pintadas à mão'],
    easter: ['Pequenas descobertas', 'Seleção de pequenos ovos de chocolate recheados'],
    flowers: ['Flores, delicadeza e afeto', 'Bolo com flores naturais coloridas'],
    pistache: ['Texturas que surpreendem', 'Chocolate recheado com pistache e frutas vermelhas'],
    chocolate: ['Aquela colherada…', 'Calda de chocolate sobre chocolate recheado'],
    hero: ['Uma inspiração que virou memória', 'Bolo com flores e joaninhas inspirado em um vestidinho de bebê']
  };
  let galleryKeys = Object.keys(gallery);
  let galleryIndex = 0;
  const lightbox = $('.lightbox');
  function showGallery(index) {
    galleryIndex = (index + galleryKeys.length) % galleryKeys.length;
    const key = galleryKeys[galleryIndex];
    const [caption, alt] = gallery[key];
    $('#lightbox-image').src = `assets/${key}.webp`;
    $('#lightbox-image').alt = alt;
    $('#lightbox-caption').textContent = caption;
    $('.lightbox-count').textContent = `${String(galleryIndex + 1).padStart(2, '0')} / ${galleryKeys.length}`;
    if (!reducedMotion) $('#lightbox-image').animate([{ opacity: .15, transform: 'scale(.97)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 450, easing: 'cubic-bezier(.2,.65,.3,1)' });
  }
  $$('[data-gallery]').forEach(button => button.addEventListener('click', () => {
    galleryKeys = Object.keys(gallery);
    showGallery(galleryKeys.indexOf(button.dataset.gallery));
    lightbox.showModal();
  }));
  $('[data-close-lightbox]').addEventListener('click', () => lightbox.close());
  $('.lightbox-prev').addEventListener('click', () => showGallery(galleryIndex - 1));
  $('.lightbox-next').addEventListener('click', () => showGallery(galleryIndex + 1));
  lightbox.addEventListener('click', event => { if (event.target === lightbox) lightbox.close(); });
  lightbox.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') { event.preventDefault(); showGallery(galleryIndex + 1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); showGallery(galleryIndex - 1); }
  });
  let touchStart = null;
  lightbox.addEventListener('touchstart', event => { touchStart = event.changedTouches[0].screenX; }, { passive: true });
  lightbox.addEventListener('touchend', event => {
    if (touchStart === null) return;
    const delta = event.changedTouches[0].screenX - touchStart;
    if (Math.abs(delta) > 65) showGallery(galleryIndex + (delta < 0 ? 1 : -1));
    touchStart = null;
  }, { passive: true });

  const orderDialog = $('.order-dialog');
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  $('#date').min = localDate;
  $$('[data-open-order]').forEach(button => button.addEventListener('click', () => orderDialog.showModal()));
  $('[data-close-order]').addEventListener('click', () => orderDialog.close());
  orderDialog.addEventListener('click', event => {
    if (event.target === orderDialog) {
      const bounds = orderDialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) orderDialog.close();
    }
  });
  $('#order-form').addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const lines = ['Olá, Jaci! Vim pelo site da Mamma Dulce e quero conversar sobre uma encomenda.', '', `Ocasião: ${data.get('occasion')}`];
    if (data.get('date')) {
      const [year, month, day] = data.get('date').split('-');
      lines.push(`Data: ${day}/${month}/${year}`);
    }
    if (data.get('guests')) lines.push(`Pessoas: ${data.get('guests')}`);
    if (data.get('idea').trim()) lines.push(`Minha ideia: ${data.get('idea').trim()}`);
    lines.push('', 'Podemos pensar em algo especial?');
    const url = `https://wa.me/5527997236993?text=${encodeURIComponent(lines.join('\n'))}`;
    $('#whatsapp-fallback').href = url;
    $('#form-status').hidden = false;
    window.open(url, '_blank', 'noopener,noreferrer');
  });
})();
