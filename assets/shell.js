/* ================================================================
   SHELL.JS — ALC-inspired editorial one-page architecture
   Kills the sidebar, builds a top-nav + sticky search + sections.
   Existing legacy modules are re-hosted into sections so their
   internal JS (strategy-advisor, daily-brief, predictive, atom,
   live-engine, chess) continues to work.
   ================================================================ */
(function(){
  'use strict';

  // 8 consolidated sections. Each maps to one or more legacy module ids.
  const SECTIONS = [
    { id: 'command',    label: 'Command',      moduleIds: ['map'] },
    { id: 'intel',      label: 'Live Intel',   moduleIds: ['intel'] },
    { id: 'strategy',   label: 'Strategy',     moduleIds: ['strategy'] },
    { id: 'brief',      label: 'Daily Brief',  moduleIds: ['brief'] },
    { id: 'predictive', label: 'Predictive',   moduleIds: ['ops','timeline'] },
    { id: 'chess',      label: 'Chess',        moduleIds: ['chess'] },
    { id: 'data',       label: 'Data Suite',   moduleIds: ['charts','water','biotech','impact','radar','status'] },
    { id: 'ask',        label: 'Ask ATOM',     moduleIds: [] }
  ];

  // Wait until legacy DOM is built (modules exist)
  function whenReady(cb){
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(cb, 0);
    } else {
      document.addEventListener('DOMContentLoaded', cb);
    }
  }

  function buildNav(){
    const nav = document.createElement('nav');
    nav.className = 'shell-nav';
    nav.innerHTML = `
      <a href="#command" class="shell-brand">
        <div class="shell-brand-logo">◆</div>
        <div class="shell-brand-stack">
          <span>Agri-Crisis <span style="color:var(--shell-accent)">Nexus</span></span>
          <span class="shell-brand-sub">A Nirmata Holdings Platform</span>
        </div>
      </a>
      <div class="shell-links">
        ${SECTIONS.map(s => `<a href="#${s.id}" class="shell-link" data-section="${s.id}">${s.label}</a>`).join('')}
      </div>
    `;
    document.body.appendChild(nav);

    // Sticky search
    const search = document.createElement('div');
    search.className = 'shell-search-wrap';
    search.innerHTML = `
      <div class="shell-search">
        <svg class="shell-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input class="shell-search-input" id="shell-search-input" placeholder="Ask ATOM anything about the agri-crisis…" autocomplete="off"/>
        <button class="shell-search-btn" id="shell-search-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
          </svg>
          Ask ATOM
        </button>
      </div>
    `;
    document.body.appendChild(search);

    // Wire search
    const input = search.querySelector('#shell-search-input');
    const btn = search.querySelector('#shell-search-btn');
    function fireSearch(){
      const q = input.value.trim();
      if (!q) return;
      if (window.ATOM && ATOM.ask) ATOM.ask(q, { mode: 'reasoning' });
      input.value = '';
    }
    btn.addEventListener('click', fireSearch);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') fireSearch(); });
  }

  function buildShell(){
    // Wrap #modules-container (or the module hosts) inside .shell-main
    const shell = document.createElement('main');
    shell.className = 'shell-main';
    shell.id = 'shell-main';

    // Section 0 — Command hero
    shell.appendChild(buildHeroSection());
    // Sections 1..N-2 — module-hosted (skip last which is ask)
    for (const s of SECTIONS.slice(1, -1)) shell.appendChild(buildSection(s));
    // Ask ATOM final section (uses existing ATOM launcher, but shows a big landing card)
    shell.appendChild(buildAskSection());
    // Footer
    shell.appendChild(buildFooter());

    // Insert after nav+search bars
    document.body.appendChild(shell);
  }

  function buildHeroSection(){
    const s = document.createElement('section');
    s.className = 'shell-section shell-section-hero';
    s.id = 'command';
    s.innerHTML = `
      <div class="shell-hero">
        <div class="shell-hero-badge">Nirmata Holdings · Strategic Intelligence Platform</div>
        <h1 class="shell-hero-title">The Agri-Crisis <span class="grad">Nexus</span></h1>
        <p class="shell-hero-sub">Real-time intelligence platform for the global food, water, and coordination crisis. Live signals, predictive forecasts, and strategic reasoning from ATOM.</p>
        <div class="shell-hero-tags">
          <span>Live Intel</span><span>Strategy</span><span>Predictive</span><span>Chess</span><span>Deep Research</span>
        </div>
        <div class="shell-hero-stats" id="shell-hero-stats">
          <div class="shell-stat"><div class="shell-stat-num" id="stat-crises">52</div><div class="shell-stat-lbl">Active Crises</div></div>
          <div class="shell-stat"><div class="shell-stat-num" id="stat-hungry">266M</div><div class="shell-stat-lbl">Hungry</div></div>
          <div class="shell-stat"><div class="shell-stat-num" id="stat-countries">195</div><div class="shell-stat-lbl">Countries</div></div>
          <div class="shell-stat"><div class="shell-stat-num" id="stat-pillars">4</div><div class="shell-stat-lbl">Pillars</div></div>
          <div class="shell-stat"><div class="shell-stat-num" id="stat-since">2026</div><div class="shell-stat-lbl">Since</div></div>
        </div>
      </div>
      <div id="shell-map-host" style="margin-top: 40px; min-height: 500px;"></div>
      <div class="shell-scroll-hint">Scroll</div>
    `;
    return s;
  }

  function buildSection(s){
    const el = document.createElement('section');
    el.className = 'shell-section' + (isEven(s.id) ? ' shell-section-alt' : '');
    el.id = s.id;
    el.dataset.sectionId = s.id;
    const meta = SECTION_META[s.id] || {};
    el.innerHTML = `
      <div class="shell-eyebrow">${meta.eyebrow || s.label.toUpperCase()}</div>
      <h2 class="shell-title">${meta.title || s.label} ${meta.gradWord ? `<span class="grad">${meta.gradWord}</span>` : ''}</h2>
      <p class="shell-subtitle">${meta.subtitle || ''}</p>
      <div class="shell-section-body" id="host-${s.id}"></div>
    `;
    return el;
  }

  function buildAskSection(){
    const s = document.createElement('section');
    s.className = 'shell-section';
    s.id = 'ask';
    s.innerHTML = `
      <div class="shell-eyebrow">Intelligence Agent</div>
      <h2 class="shell-title">Ask <span class="grad">ATOM</span></h2>
      <p class="shell-subtitle">A grounded analyst over live agri-crisis signals — global map, IPC data, commodity flows, and cross-industry web. Streaming answers with inline citations.</p>
      <div class="shell-card" style="max-width: 800px; margin: 0 auto; text-align: center; padding: 48px 32px;">
        <div style="font-size: 42px; margin-bottom: 16px;">◆</div>
        <h3 style="font-family:'Cabinet Grotesk',sans-serif; font-size:24px; font-weight:600; margin:0 0 8px;">ATOM Intelligence Agent</h3>
        <p style="color:var(--shell-text-dim); margin:0 0 24px;">Grounded in real-time signals from 40+ countries, 11 sources, and the four Nirmata pillars.</p>
        <div style="display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;">
          ${['What are the top 3 threats this week?', 'Compare Sudan vs Haiti IPC trajectories', 'Explain the Hormuz-fertilizer cascade', 'Where should Nirmata deploy next?'].map(q => `<button class="shell-search-btn" data-atom-q="${q}" style="border-radius: 999px; padding: 10px 18px;">${q}</button>`).join('')}
        </div>
      </div>
    `;
    // Wire suggestion buttons
    setTimeout(() => {
      s.querySelectorAll('[data-atom-q]').forEach(b => {
        b.addEventListener('click', () => {
          const q = b.dataset.atomQ;
          if (window.ATOM && ATOM.ask) ATOM.ask(q, { mode: 'reasoning' });
        });
      });
    }, 0);
    return s;
  }

  function buildFooter(){
    const f = document.createElement('footer');
    f.className = 'shell-footer';
    f.innerHTML = `
      <div><strong>Agri-Crisis Nexus</strong> · A Nirmata Holdings intelligence platform</div>
      <div style="margin-top:8px;">Four pillars: <strong>Secure Infrastructure</strong> · <strong>Coordination Layer</strong> · <strong>Regenerative Biology</strong> · <strong>Clinical Intelligence</strong></div>
      <div style="margin-top:16px; opacity:0.6;">© 2026 Nirmata Holdings · Chief Quantum Officer Eyes Only</div>
    `;
    return f;
  }

  const SECTION_META = {
    intel: {
      eyebrow: 'Live Signals',
      title: 'Live',
      gradWord: 'Intel Feed',
      subtitle: 'Real-time agri-crisis signals from FAO, FEWS NET, ACLED, WFP, NOAA and more — ranked by severity and cross-referenced against the Nirmata pillars.'
    },
    strategy: {
      eyebrow: 'Strategic Reasoning',
      title: 'Nirmata',
      gradWord: 'Strategy Advisor',
      subtitle: 'Six-frame strategic briefing generated by ATOM (sonar-reasoning-pro): Questions, Opportunities, Threats, Next Moves, Wildcards, Positioning — mapped to Nirmata\'s four pillars.'
    },
    brief: {
      eyebrow: 'Deep Research',
      title: 'Daily Intel',
      gradWord: 'Brief',
      subtitle: 'Constantly refreshed deep-research briefing covering the global agri-crisis and its interdependent web across energy, water, biotech, and geopolitics.'
    },
    predictive: {
      eyebrow: 'Forward Signals',
      title: 'Predictive',
      gradWord: 'Engine',
      subtitle: 'Probabilistic forecasts across food-war, biostimulant, hydrology, and geopolitical dimensions — each with confidence, horizon, and trigger conditions.'
    },
    chess: {
      eyebrow: 'Strategic Simulation',
      title: 'Nirmata',
      gradWord: 'vs. The Crisis',
      subtitle: 'Fully interactive strategic board. Move Nirmata\'s four pillars against eight active agri-crisis threats. ATOM narrates each engagement with real reasoning.'
    },
    data: {
      eyebrow: 'Data Suite',
      title: 'Charts,',
      gradWord: 'Signals & Impact',
      subtitle: 'Interactive visualizations across water, biotech, commodity, and impact dimensions. Every chart is a lens on the underlying crisis data.'
    }
  };

  function isEven(id){
    const idx = SECTIONS.findIndex(s => s.id === id);
    return idx % 2 === 1;  // alternate background for depth
  }

  function relocateModules(){
    // Move each legacy <section class="module"> into its target host div
    for (const s of SECTIONS) {
      if (!s.moduleIds.length) continue;
      const host = document.getElementById(s.id === 'command' ? 'shell-map-host' : `host-${s.id}`);
      if (!host) continue;
      for (const mid of s.moduleIds) {
        const mod = document.querySelector(`.module[data-mod="${mid}"]`);
        if (mod) {
          mod.classList.add('active');   // legacy code toggled visibility with .active
          host.appendChild(mod);
        }
      }
    }
    // Any orphan modules still on the page: hide
    document.querySelectorAll('.module').forEach(m => {
      if (!m.closest('.shell-section')) m.classList.remove('active');
    });
    // Now safe to hide the now-empty main-content wrapper
    const mc = document.getElementById('main-content');
    if (mc) mc.setAttribute('data-shell-hide', '1');
  }

  function wireActiveNav(){
    // Update active nav link on scroll
    const links = document.querySelectorAll('.shell-link');
    const sectionEls = SECTIONS.map(s => document.getElementById(s.id)).filter(Boolean);
    function update(){
      const scrollY = window.scrollY + 200;
      let active = sectionEls[0]?.id;
      for (const el of sectionEls) {
        if (el.offsetTop <= scrollY) active = el.id;
      }
      links.forEach(l => l.classList.toggle('active', l.dataset.section === active));
    }
    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  function updateHeroStats(){
    // Pull from window.COUNTRIES / MARKERS if present
    const setNum = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    if (window.COUNTRIES) {
      const critical = window.COUNTRIES.filter(c => c.ipc >= 4).length;
      const hungry = window.COUNTRIES.reduce((s,c) => s + (c.hungerPct/100)*40e6, 0);
      setNum('stat-crises', critical || 52);
      setNum('stat-hungry', (hungry ? (hungry/1e6).toFixed(0) : 266) + 'M');
      setNum('stat-countries', window.COUNTRIES.length || 195);
    }
  }

  function seedMarquee(){
    // Add a rolling headline ticker at the bottom of the hero
    const hero = document.getElementById('command');
    if (!hero) return;
    const items = [
      'SUDAN — Darfur IPC-5 confirmed across 5 states',
      'HAITI — Port-au-Prince agricultural imports halved',
      'SAHEL — Violence 34% YoY — farmland depopulated',
      'BLACK SEA — Corridor talks stall for third round',
      'HORMUZ — Fertilizer flows down 47%',
      'US MIDWEST — Ogallala depletion accelerates',
      'INDIA — Rice export ban extended through 2027',
      'CHINA — Soybean strategic reserves near record'
    ];
    const marquee = document.createElement('div');
    marquee.className = 'shell-marquee';
    marquee.innerHTML = `
      <div class="shell-marquee-track">
        ${items.concat(items).map(t => `<div class="shell-marquee-item">${t}</div>`).join('')}
      </div>
    `;
    hero.appendChild(marquee);
  }

  function initAllModules(){
    // Fire the lazy-init calls for every module since they're all visible now
    const inits = [
      ['_mapInit',      'initMap'],
      ['_radarInit',    'initRadar'],
      ['_chartsInit',   'initCharts'],
      ['_impactInit',   'initImpact'],
      ['_statusInit',   'revealStatus'],
      ['_intelInit',    'revealIntel'],
      ['_timelineInit', 'initTimeline']
    ];
    for (const [flag, fnName] of inits) {
      if (window[flag]) continue;
      const fn = window[fnName];
      if (typeof fn === 'function') {
        try { fn(); window[flag] = true; } catch(e) { console.warn(fnName, e); }
      }
    }
    // Brief + Strategy have their own mount() APIs
    try { window.NirmataBrief && NirmataBrief.mount && NirmataBrief.mount(); window._briefInit = true; } catch(e){}
    try { window.NirmataStrategy && NirmataStrategy.mount && NirmataStrategy.mount(); window._strategyInit = true; } catch(e){}
    // Water, biotech, ops, timeline may have their own render functions triggered by predictive.js
    try { window.Predictive && Predictive.render && Predictive.render(); } catch(e){}
    // Nudge Leaflet in case container moved
    setTimeout(() => {
      document.querySelectorAll('.leaflet-container').forEach(c => {
        const m = c._leaflet_map || (window.L && window.L.DomEvent && c);
        if (window._crisisMap && window._crisisMap.invalidateSize) window._crisisMap.invalidateSize();
      });
    }, 500);
  }

  function boot(){
    try {
      if (window._shellBooted) return;
      window._shellBooted = true;
      buildNav();
      buildShell();
      relocateModules();
      wireActiveNav();
      updateHeroStats();
      seedMarquee();
      initAllModules();
      // Kill the fixed filterbar that lives above main-content
      const fb = document.getElementById('filterbar'); if (fb) fb.style.display = 'none';
      window.dispatchEvent(new CustomEvent('shell:ready'));
    } catch (e) {
      console.error('Shell build failed:', e);
    }
  }

  function pollForModules(attempt = 0){
    const modCount = document.querySelectorAll('.module').length;
    if (modCount >= 13) { boot(); return; }
    if (attempt >= 60) { console.warn('Shell: gave up waiting for modules; booting anyway'); boot(); return; }
    setTimeout(() => pollForModules(attempt + 1), 300);
  }

  // -------- Init --------
  whenReady(() => setTimeout(() => pollForModules(0), 100));
})();
