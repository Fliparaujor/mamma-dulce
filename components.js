(() => {
  'use strict';
  const $ = (s,r=document) => r.querySelector(s);
  const $$ = (s,r=document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;

  // Spell UI Words Stagger / React Bits text reveal: native, progressively enhanced.
  $$('h1,h2').filter(h=>h.closest('main')).forEach(heading => {
    const label = heading.innerText.replace(/\s+/g,' ').trim();
    const walker = document.createTreeWalker(heading,NodeFilter.SHOW_TEXT);
    const nodes=[]; while(walker.nextNode()) if(!walker.currentNode.parentElement.closest('svg,.title-flower')) nodes.push(walker.currentNode);
    let index=0;
    nodes.forEach(node=>{
      const fragment=document.createDocumentFragment();
      node.textContent.split(/(\s+)/).forEach(word=>{
        if(!word.trim()){fragment.append(document.createTextNode(word));return;}
        const clip=document.createElement('span');clip.className='word-clip';clip.setAttribute('aria-hidden','true');
        const inner=document.createElement('span');inner.className='word-inner';inner.textContent=word;inner.style.setProperty('--word-index',String(index++));clip.append(inner);fragment.append(clip);
      });node.replaceWith(fragment);
    });
    heading.setAttribute('aria-label',label);heading.classList.add('words-ready');
    if(reduce||!('IntersectionObserver'in window))heading.classList.add('words-visible');
    else{const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){heading.classList.add('words-visible');observer.disconnect();}}),{threshold:.2});observer.observe(heading);}
  });

  // Unlumen shared active highlight, used in both navigation and category tabs.
  function sharedMarker(container,selector,selected,markerClass){
    if(!container)return;
    const marker=document.createElement('span');marker.className=markerClass;marker.setAttribute('aria-hidden','true');container.append(marker);
    const move=target=>{if(!target)return;marker.style.width=`${target.offsetWidth}px`;marker.style.transform=`translateX(${target.offsetLeft}px)`;};
    const reset=()=>{const target=$(selected,container);container.classList.toggle('has-current',!!target);move(target);};
    $$(selector,container).forEach(link=>{link.addEventListener('pointerenter',()=>move(link));link.addEventListener('focus',()=>move(link));link.addEventListener('click',()=>requestAnimationFrame(reset));});
    container.addEventListener('pointerleave',reset);container.addEventListener('focusout',()=>requestAnimationFrame(reset));
    new MutationObserver(reset).observe(container,{subtree:true,attributes:true,attributeFilter:['aria-current','aria-pressed']});
    if('ResizeObserver'in window)new ResizeObserver(reset).observe(container);reset();
    document.fonts?.ready.then(reset);
  }
  sharedMarker($('.desktop-nav'),'a','a[aria-current]','nav-marker');
  sharedMarker($('.collection-tabs'),'button','button[aria-pressed="true"]','filter-marker');

  // MicroKit Magnetic Fill: retain the public component's pointer ratios.
  $$('.button').forEach(button=>{
    button.dataset.ui='microkit-magnetic-fill';
    if(fine&&!reduce){
      button.addEventListener('pointermove',event=>{const b=button.getBoundingClientRect();button.style.setProperty('--magnetic-x',`${(event.clientX-b.left-b.width/2)*.14}px`);button.style.setProperty('--magnetic-y',`${(event.clientY-b.top-b.height/2)*.22}px`);});
      button.addEventListener('pointerleave',()=>{button.style.setProperty('--magnetic-x','0px');button.style.setProperty('--magnetic-y','0px');});
    }
    button.addEventListener('pointerdown',event=>{if(reduce)return;const b=button.getBoundingClientRect(),r=document.createElement('span');r.className='button-ripple';r.setAttribute('aria-hidden','true');r.style.setProperty('--ripple-x',`${event.clientX-b.left}px`);r.style.setProperty('--ripple-y',`${event.clientY-b.top}px`);button.append(r);r.addEventListener('animationend',()=>r.remove(),{once:true});});
  });

  // React Bits Circular Gallery: a small arc applied to the native accessible rail.
  $$('.photo-rail').forEach(rail=>{
    let queued=false;
    const curve=()=>{queued=false;if(reduce)return;const box=rail.getBoundingClientRect();$$('.creation',rail).filter(c=>!c.hidden).forEach(card=>{const b=card.getBoundingClientRect();const offset=Math.max(-1.2,Math.min(1.2,(b.left+b.width/2-box.left-box.width/2)/(box.width/2)));card.style.setProperty('--curve-y',`${Math.abs(offset)*17}px`);card.style.setProperty('--curve-r',`${offset*1.7}deg`);});};
    const schedule=()=>{if(!queued){queued=true;requestAnimationFrame(curve);}};
    rail.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule);new MutationObserver(schedule).observe(rail,{subtree:true,attributes:true,attributeFilter:['hidden']});schedule();
  });

  // Skiper / Bencho tilt and pointer lighting, bounded to preserve legibility.
  if(fine&&!reduce)$$('.hero-photo,.gallery-item,.order').forEach(frame=>{
    frame.addEventListener('pointermove',event=>{const b=frame.getBoundingClientRect(),x=(event.clientX-b.left)/b.width,y=(event.clientY-b.top)/b.height;frame.style.setProperty('--pointer-x',`${x*100}%`);frame.style.setProperty('--pointer-y',`${y*100}%`);frame.style.setProperty('--tilt-x',`${(y-.5)*-4}deg`);frame.style.setProperty('--tilt-y',`${(x-.5)*4}deg`);});
    frame.addEventListener('pointerleave',()=>{frame.style.setProperty('--tilt-x','0deg');frame.style.setProperty('--tilt-y','0deg');});
  });

  // Spell Signature: animate the existing sign-off and a drawn underline.
  const signature=$('.handwritten');if(signature){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 200 14');svg.setAttribute('aria-hidden','true');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M2 10C48 1 107 1 164 5S193 12 181 8M156 11l37-6');svg.append(path);signature.append(svg);}

  // Unlumen Motion FAQ: animate the measured panel height, preserving details semantics.
  const panels=$$('.flavor'),animations=new WeakMap();
  function setPanel(details,open){
    const shell=$('.flavor-motion-shell',details);animations.get(details)?.cancel();
    if(open)details.open=true;
    if(reduce){details.open=open;return;}
    const height=shell.getBoundingClientRect().height;
    const animation=shell.animate(open?[{height:'0px',opacity:0},{height:`${height}px`,opacity:1}]:[{height:`${height}px`,opacity:1},{height:'0px',opacity:0}],{duration:open?550:320,easing:'cubic-bezier(.16,1,.3,1)'});animations.set(details,animation);
    animation.onfinish=()=>{if(animations.get(details)!==animation)return;if(!open)details.open=false;animations.delete(details);};
  }
  panels.forEach(details=>{
    const content=$('.flavor-content',details),shell=document.createElement('div');shell.className='flavor-motion-shell';content.before(shell);shell.append(content);
    $('summary',details).addEventListener('click',event=>{event.preventDefault();const open=!details.open;if(open)panels.filter(p=>p!==details&&p.open).forEach(p=>setPanel(p,false));setPanel(details,open);});
  });

  // Cult Shift Card: a restrained header shift on hover; all content stays visible.
  $$('.moment-grid>div').forEach(card=>card.dataset.ui='cult-shift-card');
  $$('.rail-controls button,.lightbox-prev,.lightbox-next').forEach(button=>button.dataset.ui='microkit-next-dot-fill');
  $$('.dialog-close').forEach(button=>button.dataset.ui='uiverse-animated-icon');
  $$('.header-cta,.text-link,.scroll-hint').forEach(button=>button.dataset.ui='uiverse-arrow-transition');
  const submit=$('#order-form button[type="submit"]');if(submit){
    submit.dataset.ui='microkit-sliding-send';
    const label=document.createElement('span');label.className='send-label';
    [...submit.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).forEach(n=>label.append(n));submit.prepend(label);
    const icon=document.createElement('span');icon.className='send-leading';icon.setAttribute('aria-hidden','true');
    icon.innerHTML='<svg class="arrow-icon" viewBox="0 0 24 24" fill="none"><path d="m3 3 18 9-18 9 4-9-4-9Zm4 9h14" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';submit.prepend(icon);
  }
})();
