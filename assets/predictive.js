/* ==============================================================
   PREDICTIVE ENGINE — Correlation, scenario modeling, forecasting
   Uses Perplexity sonar-reasoning for probabilistic outputs
   ============================================================== */
(function(){
  'use strict';

  const PREDICT = {
    forecasts: [],
    scenarios: [],
    correlations: {}
  };
  window.PREDICT = PREDICT;

  // -------- Static baseline forecasts (loaded immediately, live-refreshed below) --------
  const BASELINE = [
    { id:'f1', title:'Black Sea grain corridor collapse', desc:'Full or partial closure of Odesa/Constanța corridor triggering 25%+ wheat spike within 60 days', confidence:62, severity:'high', window:'Q3-Q4 2026', trigger:['Russian escalation','Turkey shift','Insurance rates 5%+']},
    { id:'f2', title:'India rice export ban extension', desc:'Extends to broken and parboiled → Asia+Africa staple shock', confidence:78, severity:'high', window:'0-90d', trigger:['El Niño confirmed','Monsoon <90% LPA','Domestic inflation >6%']},
    { id:'f3', title:'Ogallala accelerated depletion', desc:'Kansas/OK/TX wheat belt yields down 8-12% by 2029', confidence:71, severity:'med', window:'2027-2029', trigger:['Drought Palmer <-3','Well-drilling permit spike','Corn irrigation +5%']},
    { id:'f4', title:'China-Brazil soybean super-corridor', desc:'Bypasses US → US farm-belt distress → political shock', confidence:68, severity:'high', window:'12-24mo', trigger:['CN import share to BR >75%','MG-BR rail expansion Q2','US midwest bankruptcy filings +20%']},
    { id:'f5', title:'North African cascade (EGY/TUN/MAR)', desc:'IMF program failures + wheat >€350 → protest cluster', confidence:57, severity:'high', window:'H2 2026', trigger:['Baguette price +30%','Reserves <3mo import','IMF renegotiation']},
    { id:'f6', title:'Biostimulant TAM jump', desc:'$5.6B → $12B by 2029 driven by CRISPR-linked adoption', confidence:74, severity:'low', window:'2027-2029', trigger:['EU CRISPR relaxation','India regen credit scheme','Big Ag partnerships 3+']},
    { id:'f7', title:'Weaponized fertilizer bloc', desc:'Russia+Belarus+Morocco potash cartel behavior triggers ROW pivot', confidence:44, severity:'med', window:'12-18mo', trigger:['Potash prices +40%','MOR export cap','JP+KR strategic reserves']},
    { id:'f8', title:'Sahel food-war expansion', desc:'Burkina/Mali/Niger crisis crosses to coastal states', confidence:66, severity:'high', window:'6-12mo', trigger:['Wagner rebrand ops','Coup contagion','Grain aid interception']}
  ];

  // -------- Correlation matrix (crisis vector → Nirmata Holdings pillar) --------
  const NIRMATA_MATRIX = {
    'Secure Infrastructure': {
      full: 'Nirmata — Secure Infrastructure Pillar',
      color: '#00e5ff',
      applies_to: ['supply chain security','provenance','commodity fraud','satellite comm','trading systems'],
      leverage: 'Post-quantum secured supply-chain provenance for wheat, corn, rice. Prevents state-level MITM on trading systems. Applies to FCT, Cargill, ADM, COFCO exposure.',
      solves: ['grain provenance fraud','post-quantum audit trails','sovereign food ledgers','satellite comm hardening']
    },
    'Coordination Layer': {
      full: 'Nirmata — Coordination Layer Pillar',
      color: '#00ffb3',
      applies_to: ['multi-actor coordination','field ops','NGO logistics','agri-cooperative','farm-to-fork'],
      leverage: 'Human-centered operating layer for NGOs, cooperatives, ag-input distributors during crisis. Turns fragmented actors into a single addressable network.',
      solves: ['NGO-cooperative coordination','crisis response routing','farm-to-fork transparency','labor mobilization']
    },
    'Regenerative Biology': {
      full: 'Nirmata — Regenerative Biology Pillar',
      color: '#bf5fff',
      applies_to: ['soil biology','regenerative ag','biostimulants','protein alternatives','pharma resilience'],
      leverage: 'Regenerative biology stack — soil microbiome, biostimulants, cultivated protein IP. Direct hedge against ex-crop protein collapse and fertilizer weaponization.',
      solves: ['soil microbiome restoration','biostimulant formulations','cultivated protein','pharma resilience']
    },
    'Clinical Intelligence': {
      full: 'Nirmata — Clinical Intelligence Pillar',
      color: '#f5c842',
      applies_to: ['malnutrition triage','famine health','pandemic-ag','livestock health','antibiotic resistance'],
      leverage: 'Clinical decision engine for famine triage, pediatric malnutrition, livestock disease outbreaks. Deployable to Sudan, Gaza, Sahel, Yemen.',
      solves: ['famine triage','malnutrition treatment','livestock disease','antibiotic stewardship']
    }
  };
  window.NIRMATA_MATRIX = NIRMATA_MATRIX;

  // -------- Correlate a crisis vector to Nirmata portfolio --------
  PREDICT.correlate = function(crisisText) {
    const t = (crisisText||'').toLowerCase();
    const out = [];
    Object.entries(NIRMATA_MATRIX).forEach(([brand, info]) => {
      let score = 0;
      info.applies_to.forEach(k => { if (t.includes(k.toLowerCase())) score += 25; });
      info.solves.forEach(k => { if (t.includes(k.toLowerCase().split(' ')[0])) score += 15; });
      // Keyword boosts
      if (/quantum|crypt|provenance|trading|satellite/.test(t) && brand === 'Secure Infrastructure') score += 20;
      if (/coordinat|ngo|logistic|coop|network/.test(t) && brand === 'Coordination Layer') score += 20;
      if (/soil|microbiome|biostim|regen|protein|stem/.test(t) && brand === 'Regenerative Biology') score += 20;
      if (/malnutrit|famine|clinic|health|triage|livestock/.test(t) && brand === 'Clinical Intelligence') score += 20;
      score = Math.min(100, score);
      out.push({ brand, score, ...info });
    });
    return out.sort((a,b)=>b.score-a.score);
  };

  // -------- Render forecast list --------
  PREDICT.render = function(container) {
    if (!container) return;
    PREDICT.forecasts = BASELINE.slice();
    const sorted = PREDICT.forecasts.slice().sort((a,b)=>b.confidence-a.confidence);
    container.innerHTML = `
      <div class="predictor-panel">
        <div class="predictor-title">◉ PREDICTIVE ENGINE · 8 ACTIVE FORECASTS</div>
        <div style="font-family:'Space Mono',monospace;font-size:10px;color:#7d8ba0;margin-bottom:10px;">
          Baseline model + live Perplexity Sonar refresh · Confidence = model probability × source consensus
        </div>
        <div id="forecast-list">
          ${sorted.map(f => `
            <div class="forecast-card ${f.severity}" data-fc-id="${f.id}">
              <div>
                <div class="forecast-title">${escapeHtml(f.title)}</div>
                <div class="forecast-desc">${escapeHtml(f.desc)}</div>
                <div style="margin-top:6px;font-family:'Space Mono',monospace;font-size:9px;color:#7d8ba0;">
                  TRIGGERS: ${f.trigger.map(t=>`<span style="color:#a8b4c8;margin-right:8px">◦ ${escapeHtml(t)}</span>`).join('')}
                </div>
              </div>
              <div style="text-align:right">
                <div class="forecast-conf">${f.confidence}%</div>
                <div class="forecast-window">${escapeHtml(f.window)}</div>
              </div>
              <div style="display:flex;flex-direction:column;gap:4px">
                <button class="chess-live-toggle" data-atom-forecast="${f.id}" title="Ask ATOM to expand">◉ ATOM</button>
                <button class="chess-live-toggle" data-fc-refresh="${f.id}" title="Refresh with live data" style="border-color:rgba(191,95,255,.4);color:#bf5fff">↻ LIVE</button>
              </div>
            </div>
          `).join('')}
        </div>
        <div style="margin-top:16px;padding-top:12px;border-top:1px dashed rgba(255,255,255,.08)">
          <div class="predictor-title" style="color:#00ffb3">◉ NIRMATA LEVERAGE MAP</div>
          <div style="font-family:'Satoshi',sans-serif;font-size:11px;color:#a8b4c8;margin-bottom:10px">
            Each portfolio company mapped against the strongest correlated crisis vectors.
          </div>
          <div class="nirmata-corr">
            ${Object.entries(NIRMATA_MATRIX).map(([brand, info]) => {
              const primary = correlateAcrossForecasts(brand);
              return `
                <div class="nirmata-card" data-nirmata="${escapeAttr(brand)}">
                  <div class="brand" style="color:${info.color}">${escapeHtml(brand.toUpperCase())}</div>
                  <div class="leverage">${escapeHtml(info.leverage)}</div>
                  <div class="fit-score">TOP FIT: ${escapeHtml(primary.top?.title || 'multi-vector')} · ${primary.avg}% avg</div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
        <div style="margin-top:16px;padding-top:12px;border-top:1px dashed rgba(255,255,255,.08)">
          <div class="predictor-title" style="color:#f5c842">◉ SCENARIO SANDBOX</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
            <button class="chess-live-toggle" data-scenario="collapse" style="padding:10px;border-color:rgba(255,45,85,.4);color:#ff2d55">
              ▲ BLACK SEA COLLAPSE
            </button>
            <button class="chess-live-toggle" data-scenario="cascade" style="padding:10px;border-color:rgba(191,95,255,.4);color:#bf5fff">
              ⇌ EL NIÑO + BAN CASCADE
            </button>
            <button class="chess-live-toggle" data-scenario="quantum" style="padding:10px;border-color:rgba(0,229,255,.4);color:#00e5ff">
              ◉ QUANTUM-BREAK ON TRADING
            </button>
            <button class="chess-live-toggle" data-scenario="pandemic" style="padding:10px;border-color:rgba(245,200,66,.4);color:#f5c842">
              ⚠ LIVESTOCK PANDEMIC + SANCTIONS
            </button>
          </div>
        </div>
      </div>
    `;

    // Wire ATOM buttons
    container.querySelectorAll('[data-atom-forecast]').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.atomForecast;
        const f = PREDICT.forecasts.find(x=>x.id===id);
        if (!f) return;
        window.ATOM?.ask(
          `Deep analysis on forecast "${f.title}". Current confidence: ${f.confidence}%. Triggers to monitor: ${f.trigger.join('; ')}. Give me: (1) three earliest tripwire signals to watch this week, (2) three Nirmata portfolio actions to prepare, (3) two hedges we should place. Cite sources.`,
          { mode: 'reasoning' }
        );
      };
    });
    container.querySelectorAll('[data-fc-refresh]').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.fcRefresh;
        const f = PREDICT.forecasts.find(x=>x.id===id);
        if (!f) return;
        btn.textContent = '...';
        const q = `Given the current state of global agricultural markets as of today, re-assess this forecast: "${f.title}" — "${f.desc}". Return JSON only (no prose): {confidence (0-100 integer), new_signals (array of 3 short strings), updated_window (string), one_line_rationale (string)}.`;
        const result = await window.ATOM?.silentQuery(q, 'quick');
        if (result) {
          // Extract JSON
          const m = result.text.match(/\{[\s\S]*\}/);
          if (m) {
            try {
              const j = JSON.parse(m[0]);
              f.confidence = Math.min(100, Math.max(0, Math.round(j.confidence)));
              f.window = j.updated_window || f.window;
              f.trigger = (j.new_signals && j.new_signals.length) ? j.new_signals : f.trigger;
              // Re-render just the card
              PREDICT.render(container);
              return;
            } catch(_) {}
          }
        }
        btn.textContent = '↻ LIVE';
      };
    });
    container.querySelectorAll('[data-nirmata]').forEach(card => {
      card.onclick = () => {
        const brand = card.dataset.nirmata;
        window.ATOM?.ask(
          `Build a detailed opportunity brief for ${brand} in the context of the top 3 active crisis forecasts. Emit an atom-artifact with type "memo" containing: (1) three concrete deployment plays for the next 90 days, (2) revenue model per play with realistic sizing, (3) partnerships to pursue, (4) risk factors. Format as HTML with panel styling.`,
          { mode: 'reasoning' }
        );
      };
    });
    container.querySelectorAll('[data-scenario]').forEach(btn => {
      btn.onclick = () => {
        const s = btn.dataset.scenario;
        const prompts = {
          collapse: 'Model the full 180-day scenario if the Black Sea grain corridor collapses tomorrow. Include: wheat/corn/sunflower price paths (with numbers), regional food-security cascade, chess moves each major power will play, Nirmata Holdings strategic positioning across its four pillars. Emit an atom-artifact scenario.',
          cascade: 'Model the compound scenario: severe El Niño 2026-27 + India rice ban extension + North African wheat crisis. Give me a 12-month cascade with numbered inflection points, casualty/displacement projections, commodity price paths, and where each Nirmata Holdings pillar plugs in. Emit an atom-artifact scenario.',
          quantum: 'Model the scenario: a quantum-capable state actor breaks classical encryption on major agricultural commodity trading systems. What breaks first? What is the price/supply impact? How does Nirmata Holdings\' Secure Infrastructure pillar capture this market — with concrete timeline and pricing. Emit atom-artifact scenario.',
          pandemic: 'Model the scenario: African Swine Fever variant + H5N1 mammalian transition + Russia-China grain sanctions dispute — happening in Q3 2026. Give me the systems-level cascade, Nirmata Holdings\' Clinical Intelligence + Regenerative Biology deployment path, and 3 hedges we should place now. Emit atom-artifact scenario.'
        };
        window.ATOM?.ask(prompts[s], { mode: 'reasoning' });
      };
    });
  };

  function correlateAcrossForecasts(brand) {
    const info = NIRMATA_MATRIX[brand];
    if (!info) return { avg: 0, top: null };
    let sum = 0, best = { score: -1 };
    BASELINE.forEach(f => {
      const scores = PREDICT.correlate(f.title + ' ' + f.desc);
      const bScore = scores.find(s => s.brand === brand)?.score || 0;
      sum += bScore;
      if (bScore > best.score) best = { score: bScore, title: f.title };
    });
    return { avg: Math.round(sum / BASELINE.length), top: best.title ? { title: best.title } : null };
  }

  function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function escapeAttr(s){ return escapeHtml(s).replace(/"/g,'&quot;'); }

  // -------- Mount into Ops Matrix ONLY --------
  let mounted = false;
  function mount() {
    if (mounted) return true;
    // If a stray predict-mount already exists (e.g. from a prior fallback), remove it
    const stray = document.getElementById('predict-mount');
    if (stray && stray.parentElement && stray.parentElement.tagName === 'BODY') {
      stray.remove();
    }
    const opsPane = document.querySelector('.module[data-mod="ops"]')
      || document.querySelector('[data-tab-pane="ops"]')
      || document.getElementById('pane-ops')
      || document.querySelector('.ops-container');
    if (!opsPane) return false;
    // Avoid duplicate mounts inside ops
    if (opsPane.querySelector('#predict-mount')) { mounted = true; return true; }
    const holder = document.createElement('div');
    holder.id = 'predict-mount';
    opsPane.insertBefore(holder, opsPane.firstChild);
    PREDICT.render(holder);
    mounted = true;
    return true;
  }

  // Retry until ops module is present. Never fall back to <body>.
  function tryMount(attempt = 0) {
    if (mount()) return;
    if (attempt < 20) setTimeout(() => tryMount(attempt + 1), 500);
  }

  window.addEventListener('atom:ready', () => {
    setTimeout(() => tryMount(0), 300);
  });
  // Also attempt on DOMContentLoaded in case atom:ready never fires
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(() => tryMount(0), 1000);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => tryMount(0), 1000));
  }
})();
