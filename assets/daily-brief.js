/* ==============================================================
   DAILY INTEL BRIEF
   Constantly-refreshed situational intelligence for the global
   agri-crisis and its interdependent web (energy, water, biotech,
   currency, logistics, semiconductors, migration, geopolitics).
   Uses Perplexity sonar-deep-research for the heavy brief +
   sonar for the fast news scan.
   ============================================================== */
(function(){
  'use strict';

  const CACHE_KEY = 'nirmata_brief_cache_v2';
  const HEADLINE_CACHE_KEY = 'nirmata_brief_headlines_v2';
  const BRIEF_TTL = 30 * 60 * 1000; // 30 min for deep brief
  const HEADLINE_TTL = 15 * 60 * 1000; // 15 min for headline scan
  const AUTO_INTERVAL = 30 * 60 * 1000; // 30 min auto-refresh

  const SECTIONS = [
    { id: 'top_stories',      label: 'Top Stories',           icon: '📰', color: '#00e5ff' },
    { id: 'agri_shocks',      label: 'Agri Shocks',           icon: '🌾', color: '#f5c842' },
    { id: 'cross_industry',   label: 'Cross-Industry Ripples', icon: '🔗', color: '#bf5fff' },
    { id: 'geopolitics',      label: 'Geopolitics',           icon: '⚔️', color: '#ff2d55' },
    { id: 'climate_water',    label: 'Climate & Water',       icon: '🌊', color: '#00ffb3' },
    { id: 'biotech_tech',     label: 'Biotech & Tech',        icon: '🧬', color: '#bf5fff' },
    { id: 'markets',          label: 'Markets & Commodities', icon: '📊', color: '#f5c842' },
    { id: 'nirmata_implications', label: 'Nirmata Implications', icon: '◆', color: '#00ffb3' }
  ];

  const CROSS_INDUSTRY_WEB = [
    { from: 'Energy',        to: 'Fertilizer',   desc: 'Natural gas → ammonia → urea' },
    { from: 'Semiconductors', to: 'Precision Ag', desc: 'GPS, sensors, autonomous machinery' },
    { from: 'Currency',      to: 'Grain Flows',  desc: 'USD strength shifts import affordability' },
    { from: 'Water',         to: 'Migration',    desc: 'Aquifer depletion drives displacement' },
    { from: 'Pandemic',      to: 'Livestock',    desc: 'Zoonotic outbreaks disrupt protein supply' },
    { from: 'Shipping',      to: 'Food Security', desc: 'Choke-point closures cascade into famines' },
    { from: 'AI/Compute',    to: 'Yield Forecasting', desc: 'Satellite + LLM = new decision moats' },
    { from: 'Rare Earths',   to: 'Ag Machinery', desc: 'Battery/motor supply chain vulnerability' },
    { from: 'Interest Rates', to: 'Farm Debt',    desc: 'Rate shocks trigger farm consolidation' }
  ];

  const Brief = {
    active: 'top_stories',
    brief: null,        // full deep brief
    headlines: [],      // fast news scan
    briefLoading: false,
    headlineLoading: false,
    lastBrief: 0,
    lastHeadlines: 0,
    autoRefresh: false,
    autoTimer: null,
    countdown: 0,
    countdownTimer: null
  };
  window.NirmataBrief = Brief;

  function mount() {
    const host = document.querySelector('.module[data-mod="brief"] .panel-body#brief-body');
    if (!host) return;
    host.innerHTML = `
      <div class="brief-header">
        <div class="brief-header-l">
          <div class="brief-eyebrow">◆ NIRMATA HOLDINGS · DAILY INTEL BRIEF</div>
          <div class="brief-title">Global Agri-Crisis · Interdependent Web · Constantly Refreshed</div>
          <div class="brief-sub">
            Powered by sonar-deep-research + sonar · Premium sources · Cross-industry signal graph
          </div>
        </div>
        <div class="brief-header-r">
          <div class="brief-live-dot"><span></span> LIVE</div>
          <button id="brief-refresh-headlines" class="brief-btn brief-btn-ghost">↻ HEADLINES</button>
          <button id="brief-refresh-full" class="brief-btn brief-btn-primary">◆ REGENERATE FULL BRIEF</button>
          <label class="brief-auto-toggle">
            <input type="checkbox" id="brief-auto">
            <span>Auto-refresh 30 min</span>
          </label>
        </div>
      </div>

      <div class="brief-meta-bar">
        <div class="brief-meta-item"><span class="brief-meta-label">HEADLINES</span> <span id="brief-headline-time">never</span></div>
        <div class="brief-meta-item"><span class="brief-meta-label">FULL BRIEF</span> <span id="brief-full-time">never</span></div>
        <div class="brief-meta-item"><span class="brief-meta-label">NEXT AUTO</span> <span id="brief-countdown">—</span></div>
      </div>

      <div class="brief-layout">
        <div class="brief-left">
          <div class="brief-panel-title">
            <span>📰 LIVE HEADLINE STREAM</span>
            <span class="brief-panel-hint">Auto-refreshed · 15 min</span>
          </div>
          <div class="brief-headlines" id="brief-headlines">
            <div class="brief-empty-small">No headlines yet. Click ↻ HEADLINES to fetch.</div>
          </div>

          <div class="brief-panel-title mt-24">
            <span>🔗 INTERDEPENDENT WEB</span>
            <span class="brief-panel-hint">Click any edge to ask ATOM</span>
          </div>
          <div class="brief-web" id="brief-web">
            ${CROSS_INDUSTRY_WEB.map(e => `
              <div class="brief-web-edge" data-from="${escapeAttr(e.from)}" data-to="${escapeAttr(e.to)}" data-desc="${escapeAttr(e.desc)}">
                <span class="brief-web-from">${escapeHtml(e.from)}</span>
                <span class="brief-web-arrow">→</span>
                <span class="brief-web-to">${escapeHtml(e.to)}</span>
                <span class="brief-web-desc">${escapeHtml(e.desc)}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="brief-right">
          <div class="brief-section-tabs" id="brief-section-tabs">
            ${SECTIONS.map(s => `
              <button class="brief-section-tab ${s.id === Brief.active ? 'active' : ''}"
                      data-sec="${s.id}" style="--sec:${s.color}">
                <span>${s.icon}</span> ${s.label}
              </button>
            `).join('')}
          </div>
          <div class="brief-section-body" id="brief-section-body">
            <div class="brief-empty">
              <div class="brief-empty-icon">◆</div>
              <div class="brief-empty-title">No brief yet</div>
              <div class="brief-empty-sub">Generate a fresh deep-research brief covering the global agri-crisis and its interdependent web across energy, water, semiconductors, geopolitics, climate, biotech, currency, and logistics.</div>
              <button id="brief-run-first" class="brief-btn brief-btn-primary">◆ GENERATE FULL BRIEF</button>
              <div class="brief-empty-sub" style="margin-top:12px;font-size:11px;color:#7d8ba0">
                Deep research takes 45-90 seconds. Uses <strong>sonar-deep-research</strong> against premium sources.
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Wire events
    document.getElementById('brief-refresh-headlines').addEventListener('click', refreshHeadlines);
    document.getElementById('brief-refresh-full').addEventListener('click', refreshFullBrief);
    document.getElementById('brief-run-first').addEventListener('click', refreshFullBrief);
    document.getElementById('brief-auto').addEventListener('change', e => {
      Brief.autoRefresh = e.target.checked;
      if (Brief.autoRefresh) {
        startAuto();
        pushToast('Auto-refresh ON · brief regenerates every 30 min');
      } else {
        stopAuto();
        pushToast('Auto-refresh OFF');
      }
    });
    document.querySelectorAll('.brief-section-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        Brief.active = btn.dataset.sec;
        document.querySelectorAll('.brief-section-tab').forEach(b =>
          b.classList.toggle('active', b === btn));
        renderSection();
      });
    });
    document.querySelectorAll('.brief-web-edge').forEach(el => {
      el.addEventListener('click', () => {
        const from = el.dataset.from;
        const to = el.dataset.to;
        const desc = el.dataset.desc;
        if (window.ATOM && ATOM.ask) {
          ATOM.ask(`Trace the current pathway from ${from} → ${to} (${desc}). Show me: recent trigger events in the last 30 days, current propagation stage, downstream effects on global food security, and Nirmata Holdings' strategic leverage points.`, { mode: 'reasoning' });
        }
      });
    });

    // Load cache
    loadCache();
    updateMetaBar();
    if (Brief.headlines.length) renderHeadlines();
    if (Brief.brief) renderSection();

    // Auto-fetch headlines on first mount (cheap)
    if (!Brief.headlines.length || (Date.now() - Brief.lastHeadlines > HEADLINE_TTL)) {
      refreshHeadlines();
    }
  }

  function loadCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        const j = JSON.parse(raw);
        if (j.brief && j.lastBrief && (Date.now() - j.lastBrief < BRIEF_TTL * 4)) {
          Brief.brief = j.brief;
          Brief.lastBrief = j.lastBrief;
        }
      }
      const raw2 = sessionStorage.getItem(HEADLINE_CACHE_KEY);
      if (raw2) {
        const j2 = JSON.parse(raw2);
        if (j2.headlines && j2.lastHeadlines && (Date.now() - j2.lastHeadlines < HEADLINE_TTL * 3)) {
          Brief.headlines = j2.headlines;
          Brief.lastHeadlines = j2.lastHeadlines;
        }
      }
    } catch (_) {}
  }
  function saveBriefCache() {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        brief: Brief.brief, lastBrief: Brief.lastBrief
      }));
    } catch (_) {}
  }
  function saveHeadlineCache() {
    try {
      sessionStorage.setItem(HEADLINE_CACHE_KEY, JSON.stringify({
        headlines: Brief.headlines, lastHeadlines: Brief.lastHeadlines
      }));
    } catch (_) {}
  }

  // -------- Headline scan (fast) --------
  async function refreshHeadlines() {
    Brief.headlineLoading = true;
    renderHeadlines();
    const prompt = `Scan the last 24-48 hours of global news for the 10 most consequential developments affecting the global agri-crisis and its interdependent industries (energy, water, semiconductors, currency, geopolitics, climate, biotech, logistics, migration). Prioritize items from Reuters, Bloomberg, FT, WSJ, AP, Al Jazeera, USDA, FAO, Xinhua, RIA Novosti, Zerohedge, Politico, Nikkei, Handelsblatt, Le Monde.

For each, return one card. Respond ONLY with a JSON code block:

\`\`\`json
{
  "generated_at": "ISO timestamp",
  "cards": [
    {
      "headline": "sharp 8-12 word headline",
      "source": "publication",
      "region": "region or global",
      "category": "agri|energy|water|climate|geopolitics|biotech|markets|semiconductors|logistics|migration",
      "severity": 1-10,
      "one_liner": "single-sentence explainer",
      "nirmata_relevance": "one-line why this matters for Nirmata Holdings' 4-pillar strategy"
    }
  ]
}
\`\`\``;

    try {
      const res = await fetch('/api/atom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          mode: 'quick',
          context: buildContext(),
          stream: false
        })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const text = j.choices?.[0]?.message?.content || '';
      const citations = j.citations || [];
      const parsed = parseJson(text);
      if (parsed && parsed.cards) {
        Brief.headlines = parsed.cards.map((c, i) => ({
          ...c,
          citation: citations[i] || citations[0] || null
        }));
        Brief.lastHeadlines = Date.now();
        saveHeadlineCache();
      }
    } catch (e) {
      console.warn('Headlines failed', e);
      Brief.headlines = [{
        headline: 'Failed to fetch headlines',
        source: 'system', region: 'n/a', category: 'system',
        severity: 1, one_liner: String(e.message || e),
        nirmata_relevance: 'Retry from the button above.'
      }];
    } finally {
      Brief.headlineLoading = false;
      renderHeadlines();
      updateMetaBar();
    }
  }

  function renderHeadlines() {
    const host = document.getElementById('brief-headlines');
    if (!host) return;
    if (Brief.headlineLoading && !Brief.headlines.length) {
      host.innerHTML = `<div class="brief-loading-small">
        <div class="brief-spinner"></div>
        <div>Scanning global headline stream…</div>
      </div>`;
      return;
    }
    if (!Brief.headlines.length) {
      host.innerHTML = `<div class="brief-empty-small">No headlines yet.</div>`;
      return;
    }
    host.innerHTML = Brief.headlines.map((h, i) => {
      const sev = Math.max(1, Math.min(10, h.severity || 5));
      const sevClass = sev >= 8 ? 'crit' : sev >= 6 ? 'high' : sev >= 4 ? 'mod' : 'low';
      return `
        <div class="brief-headline-card sev-${sevClass}" data-i="${i}">
          <div class="brief-headline-top">
            <span class="brief-headline-sev">SEV ${sev}</span>
            <span class="brief-headline-cat">${escapeHtml(h.category || '—')}</span>
            <span class="brief-headline-region">${escapeHtml(h.region || 'global')}</span>
          </div>
          <div class="brief-headline-title">${escapeHtml(h.headline || '')}</div>
          <div class="brief-headline-source">${escapeHtml(h.source || 'unknown')}</div>
          <div class="brief-headline-oneline">${escapeHtml(h.one_liner || '')}</div>
          ${h.nirmata_relevance ? `<div class="brief-headline-nir"><span>◆</span> ${escapeHtml(h.nirmata_relevance)}</div>` : ''}
          <div class="brief-headline-actions">
            ${h.citation ? `<a href="${escapeAttr(h.citation)}" target="_blank" rel="noopener" class="brief-headline-src-link">SOURCE →</a>` : ''}
            <button class="brief-headline-ask" data-i="${i}">ASK ATOM →</button>
          </div>
        </div>
      `;
    }).join('');
    host.querySelectorAll('.brief-headline-ask').forEach(btn => {
      btn.addEventListener('click', () => {
        const h = Brief.headlines[+btn.dataset.i];
        if (!h) return;
        if (window.ATOM && ATOM.ask) {
          ATOM.ask(`Deep-dive on this headline: "${h.headline}" (${h.source}, ${h.region}). Give me: (1) verified facts vs. speculation, (2) 24-72h forward implications, (3) how this cascades through the food-water-energy-security web, (4) Nirmata Holdings strategic response across its four pillars.`, { mode: 'reasoning' });
        }
      });
    });
  }

  // -------- Full brief (deep) --------
  async function refreshFullBrief() {
    Brief.briefLoading = true;
    renderSection();
    const prompt = `Produce a comprehensive DAILY INTEL BRIEF for Chief Quantum Officer Ben O'Leary and Co-founder Joel Bedard of Nirmata Holdings, focused on the global agri-crisis and its interdependent web across energy, water, semiconductors, geopolitics, climate, biotech, currency, logistics, and migration. Use the most recent 24-72 hours of premium reporting (Reuters, Bloomberg, FT, WSJ, AP, FAO, USDA, IEA, IMF, IPCC, Nature, Science, Nikkei, Al Jazeera, Xinhua, Politico, Le Monde, Handelsblatt, Zerohedge for contrarian signal).

Respond ONLY as a JSON code block with this exact schema:

\`\`\`json
{
  "generated_at": "ISO timestamp",
  "executive_summary": "3-4 sentence bottom-line synthesis for Ben and Joel",
  "sections": {
    "top_stories": {
      "title": "Top Stories",
      "items": [
        { "title": "...", "detail": "3-4 sentences with specifics: names, numbers, dates", "sources": ["Reuters","Bloomberg"], "severity": 1-10, "nirmata_link": "how this ties to Nirmata's 4 pillars" }
      ]
    },
    "agri_shocks": { "title": "Agri Shocks", "items": [...] },
    "cross_industry": {
      "title": "Cross-Industry Ripples",
      "items": [
        { "title": "e.g. Ammonia → Wheat cascade tightens", "detail": "explain the pathway with specifics", "chain": ["Energy","Fertilizer","Grain","Food"], "sources": [...], "severity": 1-10, "nirmata_link": "..." }
      ]
    },
    "geopolitics": { "title": "Geopolitics", "items": [...] },
    "climate_water": { "title": "Climate & Water", "items": [...] },
    "biotech_tech": { "title": "Biotech & Tech", "items": [...] },
    "markets": { "title": "Markets & Commodities", "items": [...] },
    "nirmata_implications": {
      "title": "Nirmata Implications",
      "items": [
        { "title": "sharp actionable implication", "detail": "what Nirmata should do or investigate given the day's news", "pillar": "secure|coord|bio|clinical|cross", "priority": 1-10, "nirmata_link": "specific pillar leverage" }
      ]
    }
  },
  "risk_gauge": {
    "food_security": 1-10,
    "geopolitical": 1-10,
    "climate": 1-10,
    "market": 1-10,
    "tech_infra": 1-10
  },
  "watch_list": ["3-5 items to watch in the next 24-48h"]
}
\`\`\`

Every section should have 3-5 items. Include real named entities (countries, companies, people), real numbers (prices, dates, tonnage), and cite specific sources. Do not fabricate — if uncertain, say so. Avoid generic filler.`;

    try {
      const res = await fetch('/api/atom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          mode: 'deep',
          context: buildContext(),
          stream: false
        })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const text = j.choices?.[0]?.message?.content || '';
      const citations = j.citations || [];
      const parsed = parseJson(text);
      if (parsed && parsed.sections) {
        Brief.brief = { ...parsed, citations };
        Brief.lastBrief = Date.now();
        saveBriefCache();
      } else {
        throw new Error('Deep brief did not return valid JSON');
      }
    } catch (e) {
      console.warn('Full brief failed', e);
      Brief.brief = { error: String(e.message || e) };
    } finally {
      Brief.briefLoading = false;
      renderSection();
      updateMetaBar();
    }
  }

  function renderSection() {
    const host = document.getElementById('brief-section-body');
    if (!host) return;
    if (Brief.briefLoading) {
      host.innerHTML = `
        <div class="brief-loading">
          <div class="brief-loading-orb"><span></span><span></span><span></span></div>
          <div class="brief-loading-title">Running deep research…</div>
          <div class="brief-loading-sub">sonar-deep-research · scanning premium sources · this takes 45-90 seconds</div>
          <div class="brief-loading-progress"><span></span></div>
        </div>`;
      return;
    }
    if (!Brief.brief) {
      host.innerHTML = `
        <div class="brief-empty">
          <div class="brief-empty-icon">◆</div>
          <div class="brief-empty-title">No brief yet</div>
          <div class="brief-empty-sub">Click ◆ REGENERATE FULL BRIEF to generate.</div>
        </div>`;
      return;
    }
    if (Brief.brief.error) {
      host.innerHTML = `
        <div class="brief-empty">
          <div class="brief-empty-icon">⚠</div>
          <div class="brief-empty-title">Deep brief failed</div>
          <div class="brief-empty-sub" style="color:#ff7a90">${escapeHtml(Brief.brief.error)}</div>
          <button id="brief-retry" class="brief-btn brief-btn-primary">RETRY</button>
        </div>`;
      document.getElementById('brief-retry').addEventListener('click', refreshFullBrief);
      return;
    }

    const brief = Brief.brief;
    const section = brief.sections?.[Brief.active];

    const execHtml = `
      <div class="brief-exec">
        <div class="brief-exec-label">◆ EXECUTIVE SUMMARY · ${new Date(Brief.lastBrief).toLocaleString()}</div>
        <div class="brief-exec-body">${escapeHtml(brief.executive_summary || '')}</div>
      </div>
    `;

    const gaugeHtml = brief.risk_gauge ? `
      <div class="brief-gauges">
        ${Object.entries(brief.risk_gauge).map(([k, v]) => {
          const val = Math.max(1, Math.min(10, v || 1));
          const cls = val >= 8 ? 'crit' : val >= 6 ? 'high' : val >= 4 ? 'mod' : 'low';
          return `
            <div class="brief-gauge ${cls}">
              <div class="brief-gauge-label">${escapeHtml(k.replace(/_/g,' '))}</div>
              <div class="brief-gauge-bar"><span style="width:${val*10}%"></span></div>
              <div class="brief-gauge-num">${val}/10</div>
            </div>
          `;
        }).join('')}
      </div>
    ` : '';

    const watchHtml = brief.watch_list && brief.watch_list.length ? `
      <div class="brief-watch">
        <div class="brief-watch-label">◆ WATCH LIST · NEXT 24-48H</div>
        <ul>${brief.watch_list.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
      </div>
    ` : '';

    const items = section?.items || [];
    const secConfig = SECTIONS.find(s => s.id === Brief.active) || {};

    const itemsHtml = items.length ? items.map((it, i) => renderBriefItem(it, i, secConfig)).join('') :
      `<div class="brief-empty-small">No items in this section.</div>`;

    const citHtml = brief.citations && brief.citations.length ? `
      <div class="brief-citations">
        <span class="brief-citations-label">SOURCES USED (${brief.citations.length}):</span>
        ${brief.citations.slice(0, 15).map((c, i) =>
          `<a href="${escapeAttr(c)}" target="_blank" rel="noopener">[${i+1}]</a>`).join(' ')}
      </div>
    ` : '';

    host.innerHTML = `
      ${execHtml}
      ${gaugeHtml}
      <div class="brief-section-head" style="--sec:${secConfig.color || '#00e5ff'}">
        <div class="brief-section-head-icon">${secConfig.icon || '◆'}</div>
        <div class="brief-section-head-title">${escapeHtml(section?.title || secConfig.label || '')}</div>
        <div class="brief-section-head-count">${items.length} ITEMS</div>
      </div>
      <div class="brief-items">${itemsHtml}</div>
      ${watchHtml}
      ${citHtml}
    `;

    host.querySelectorAll('.brief-item-ask').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.title;
        const d = btn.dataset.detail;
        if (window.ATOM && ATOM.ask) {
          ATOM.ask(`Drill into this brief item: "${t}". Context: ${d}. Give me: (1) verified evidence base, (2) 3 second-order effects, (3) Nirmata Holdings play across the four pillars, (4) what could invalidate this view.`, { mode: 'reasoning' });
        }
      });
    });
  }

  function renderBriefItem(it, i, secConfig) {
    const sev = Math.max(1, Math.min(10, it.severity || it.priority || 5));
    const sevClass = sev >= 8 ? 'crit' : sev >= 6 ? 'high' : sev >= 4 ? 'mod' : 'low';
    const sources = Array.isArray(it.sources) ? it.sources : [];
    const chain = Array.isArray(it.chain) ? it.chain : null;
    return `
      <div class="brief-item sev-${sevClass}" style="--sec:${secConfig.color || '#00e5ff'}">
        <div class="brief-item-head">
          <span class="brief-item-num">${String(i+1).padStart(2,'0')}</span>
          <span class="brief-item-sev">SEV ${sev}</span>
          ${it.pillar ? `<span class="brief-item-pillar">◆ ${escapeHtml(it.pillar)}</span>` : ''}
        </div>
        <div class="brief-item-title">${escapeHtml(it.title || '')}</div>
        <div class="brief-item-detail">${escapeHtml(it.detail || '')}</div>
        ${chain ? `
          <div class="brief-item-chain">
            ${chain.map((c, j) => `<span class="brief-item-chain-node">${escapeHtml(c)}</span>${j < chain.length-1 ? '<span class="brief-item-chain-arrow">→</span>' : ''}`).join('')}
          </div>
        ` : ''}
        ${it.nirmata_link ? `<div class="brief-item-nirmata"><span>◆ NIRMATA:</span> ${escapeHtml(it.nirmata_link)}</div>` : ''}
        <div class="brief-item-foot">
          ${sources.length ? `<span class="brief-item-sources">${sources.map(s => `<span>${escapeHtml(s)}</span>`).join('')}</span>` : ''}
          <button class="brief-item-ask" data-title="${escapeAttr(it.title || '')}" data-detail="${escapeAttr(it.detail || '')}">ASK ATOM →</button>
        </div>
      </div>
    `;
  }

  // -------- Auto-refresh --------
  function startAuto() {
    stopAuto();
    Brief.countdown = Math.floor(AUTO_INTERVAL / 1000);
    Brief.autoTimer = setInterval(() => {
      Brief.countdown = Math.floor(AUTO_INTERVAL / 1000);
      refreshHeadlines();
      refreshFullBrief();
    }, AUTO_INTERVAL);
    Brief.countdownTimer = setInterval(() => {
      Brief.countdown = Math.max(0, Brief.countdown - 1);
      updateMetaBar();
    }, 1000);
    updateMetaBar();
  }
  function stopAuto() {
    if (Brief.autoTimer) clearInterval(Brief.autoTimer);
    if (Brief.countdownTimer) clearInterval(Brief.countdownTimer);
    Brief.autoTimer = null;
    Brief.countdownTimer = null;
    updateMetaBar();
  }

  function updateMetaBar() {
    const h = document.getElementById('brief-headline-time');
    const f = document.getElementById('brief-full-time');
    const c = document.getElementById('brief-countdown');
    if (h) h.textContent = Brief.lastHeadlines ? formatRel(Brief.lastHeadlines) : 'never';
    if (f) f.textContent = Brief.lastBrief ? formatRel(Brief.lastBrief) : 'never';
    if (c) {
      if (Brief.autoRefresh) {
        const m = Math.floor(Brief.countdown / 60);
        const s = Brief.countdown % 60;
        c.textContent = `${m}m ${String(s).padStart(2,'0')}s`;
      } else {
        c.textContent = 'OFF';
      }
    }
  }

  // -------- Helpers --------
  function parseJson(text) {
    const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('{');
    if (start < 0) return null;
    let depth = 0, end = -1;
    for (let i = start; i < candidate.length; i++) {
      if (candidate[i] === '{') depth++;
      else if (candidate[i] === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end < 0) return null;
    try { return JSON.parse(candidate.slice(start, end)); }
    catch (e) { console.warn('brief parse fail', e); return null; }
  }
  function buildContext() {
    const critical = (window.COUNTRIES || [])
      .filter(c => c.ipc >= 4).slice(0, 8)
      .map(c => `${c.name}(IPC${c.ipc})`).join(', ');
    return `Task: Daily Intel Brief for Nirmata Holdings (CQO Ben O'Leary + Co-founder Joel Bedard). Current top crisis zones: ${critical}. Focus on global agri-crisis + interdependent web (energy, water, semiconductors, currency, geopolitics, climate, biotech, logistics, migration).`;
  }
  function formatRel(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    return `${Math.floor(s/86400)}d ago`;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }
  function pushToast(msg) {
    let t = document.getElementById('brief-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'brief-toast';
      t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.85);color:#00ffb3;padding:10px 20px;border-radius:8px;border:1px solid rgba(0,255,179,.4);font-family:"Space Mono",monospace;font-size:12px;z-index:99999;transition:opacity .3s;pointer-events:none';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3200);
  }

  window.NirmataBrief.mount = mount;
})();
