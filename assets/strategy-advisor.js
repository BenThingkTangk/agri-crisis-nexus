/* ==============================================================
   NIRMATA STRATEGY ADVISOR
   Dynamic, self-updating strategy engine for Ben O'Leary (CQO)
   and Joel Bedard (co-founder). Uses Perplexity sonar-reasoning
   to surface what to build, what questions to answer, and where
   Nirmata's four pillars have the highest strategic leverage right now.
   ============================================================== */
(function(){
  'use strict';

  const CACHE_KEY = 'nirmata_strategy_cache_v2';
  const CACHE_TTL = 60 * 60 * 1000; // 60 minutes

  // The four Nirmata Holdings pillars
  const PILLARS = [
    { key: 'secure',   name: 'Secure Infrastructure',   icon: '🛡️', color: '#00e5ff',
      desc: 'Post-quantum cryptography, provenance systems, supply-chain integrity.' },
    { key: 'coord',    name: 'Coordination Layer',      icon: '🧭', color: '#00ffb3',
      desc: 'Human-centered OS for multi-actor field operations.' },
    { key: 'bio',      name: 'Regenerative Biology',    icon: '🧬', color: '#bf5fff',
      desc: 'Soil, microbiome, and biotech interventions.' },
    { key: 'clinical', name: 'Clinical Intelligence',   icon: '🩺', color: '#f5c842',
      desc: 'Decision AI for famine, malnutrition, and livestock health.' }
  ];

  // Strategic frames — the six lenses ATOM uses to advise
  const FRAMES = [
    { id: 'questions',    label: 'Questions To Answer',   icon: '❓',
      prompt: 'What are the 6 most important strategic questions Ben (CQO) and Joel (co-founder) of Nirmata Holdings must answer in the next 30 days about the impending global food war? Each question should be sharp, decision-forcing, and tied to Nirmata\'s ability to capture value. For each, note (a) why it matters now, (b) what data would resolve it, (c) which pillar it maps to, (d) an urgency score 1-10.' },
    { id: 'opportunities', label: 'Opportunities',        icon: '💎',
      prompt: 'Identify 6 concrete high-leverage OPPORTUNITIES for Nirmata Holdings right now in the global agri-crisis, drawing on the latest 30 days of news. Each must map to one of the four Nirmata pillars (Secure Infrastructure, Coordination Layer, Regenerative Biology, Clinical Intelligence). For each: name, one-line description, addressable market size, first-mover advantage 1-10, time-to-first-revenue estimate, why this is a Nirmata-shaped opportunity specifically.' },
    { id: 'threats',      label: 'Threats & Blockers',    icon: '⚠️',
      prompt: 'What are the 5 most serious THREATS or blockers to Nirmata Holdings\' agri-crisis strategy over the next 6-12 months? Consider: regulatory shifts, geopolitical events, competing platforms (Palantir Foundry, Descartes Labs, John Deere, Bayer, etc.), commodity shocks, climate tail-risks. For each: what it is, likelihood 1-10, potential impact 1-10, and how Nirmata can defend or neutralize.' },
    { id: 'moves',        label: 'Next Moves',            icon: '♟️',
      prompt: 'Prescribe 5 concrete NEXT MOVES Nirmata Holdings should execute in the next 90 days. Each move should be: specific (not "explore X"), ownable (assign to Ben or Joel or "hire"), measurable (has a KPI), timed (has a deadline), and tied to a pillar. Prioritize moves that create defensible strategic assets (data moats, partnerships, IP) over one-off deals.' },
    { id: 'wildcards',    label: 'Wildcards & Signals',   icon: '🎲',
      prompt: 'Surface 5 non-obvious WILDCARD signals or emerging patterns from the last 14 days of global news that could reshape the agri-crisis. Focus on cross-industry ripple effects: energy → fertilizer, semiconductors → precision ag, currency → grain flows, pandemic → livestock, water → migration. For each: the signal, the pattern it suggests, the Nirmata implication, confidence 1-10.' },
    { id: 'differentiation', label: 'Positioning',        icon: '🎯',
      prompt: 'How should Nirmata Holdings POSITION itself in the market vs. incumbent players (Palantir, Descartes Labs, John Deere, Cargill, Bayer, Bloomberg, agtech VCs)? Give 4 differentiation vectors: name, one-line pitch, defensibility (moat), which pillar it leverages, and a headline example use-case. Be sharp, contrarian, and specific.' }
  ];

  const StrategyAdvisor = {
    activeFrame: 'questions',
    data: {},   // per-frame results
    loading: {}, // per-frame boolean
    lastUpdate: {},
    autoRefresh: false,
    autoRefreshTimer: null
  };
  window.NirmataStrategy = StrategyAdvisor;

  // -------- Mount --------
  function mount() {
    const host = document.querySelector('.module[data-mod="strategy"] .panel-body#strategy-body');
    if (!host) return;
    host.innerHTML = `
      <div class="strategy-header">
        <div class="strategy-header-l">
          <div class="strategy-eyebrow">◆ NIRMATA HOLDINGS · STRATEGY ADVISOR</div>
          <div class="strategy-title">What we should build. What we should answer. What we should do next.</div>
          <div class="strategy-sub">Powered by sonar-reasoning-pro · Refreshed on-demand · Ben O'Leary (CQO) + Joel Bedard (Co-founder)</div>
        </div>
        <div class="strategy-header-r">
          <button id="strategy-refresh-all" class="strategy-btn strategy-btn-primary">↻ REFRESH ALL FRAMES</button>
          <label class="strategy-auto-toggle">
            <input type="checkbox" id="strategy-auto">
            <span>Auto-refresh every 60 min</span>
          </label>
        </div>
      </div>

      <div class="strategy-pillars">
        ${PILLARS.map(p => `
          <div class="strategy-pillar" data-pillar="${p.key}" style="--pillar:${p.color}">
            <div class="strategy-pillar-icon">${p.icon}</div>
            <div class="strategy-pillar-name">${p.name}</div>
            <div class="strategy-pillar-desc">${p.desc}</div>
          </div>
        `).join('')}
      </div>

      <div class="strategy-frames" id="strategy-frames">
        ${FRAMES.map(f => `
          <button class="strategy-frame-tab ${f.id === StrategyAdvisor.activeFrame ? 'active' : ''}"
                  data-frame="${f.id}">
            <span class="strategy-frame-icon">${f.icon}</span>
            <span class="strategy-frame-label">${f.label}</span>
          </button>
        `).join('')}
      </div>

      <div class="strategy-frame-body" id="strategy-frame-body">
        <div class="strategy-empty">
          <div class="strategy-empty-icon">◆</div>
          <div class="strategy-empty-title">Pick a strategic lens above</div>
          <div class="strategy-empty-sub">ATOM will reason through the latest agri-crisis signals via sonar-reasoning-pro and surface the sharpest 5-6 insights for that frame — tied to Nirmata's four pillars.</div>
          <button id="strategy-run-first" class="strategy-btn strategy-btn-primary">GENERATE STRATEGIC BRIEFING</button>
        </div>
      </div>

      <div class="strategy-cross">
        <div class="strategy-cross-title">◆ CROSS-CUTTING DECISION MATRIX</div>
        <div class="strategy-cross-sub">Every insight is mapped to a pillar (colored dot) and an urgency score. Click any card to open ATOM in reasoning mode and drill deeper.</div>
        <div id="strategy-decision-matrix" class="strategy-decision-matrix"></div>
      </div>
    `;

    // Wire events
    document.getElementById('strategy-refresh-all').addEventListener('click', refreshAll);
    document.getElementById('strategy-run-first').addEventListener('click', () => run(StrategyAdvisor.activeFrame));
    document.getElementById('strategy-auto').addEventListener('change', e => {
      StrategyAdvisor.autoRefresh = e.target.checked;
      if (StrategyAdvisor.autoRefresh) {
        StrategyAdvisor.autoRefreshTimer = setInterval(refreshAll, 60 * 60 * 1000);
        pushToast('Auto-refresh enabled · 60 min interval');
      } else {
        clearInterval(StrategyAdvisor.autoRefreshTimer);
        pushToast('Auto-refresh disabled');
      }
    });

    document.querySelectorAll('.strategy-frame-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        StrategyAdvisor.activeFrame = btn.dataset.frame;
        document.querySelectorAll('.strategy-frame-tab').forEach(b =>
          b.classList.toggle('active', b === btn));
        renderFrame(StrategyAdvisor.activeFrame);
      });
    });

    // Try loading cached data
    loadCache();
    renderFrame(StrategyAdvisor.activeFrame);
    renderDecisionMatrix();
  }

  // -------- Cache --------
  function loadCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const j = JSON.parse(raw);
      const now = Date.now();
      Object.keys(j.data || {}).forEach(key => {
        if (j.lastUpdate?.[key] && (now - j.lastUpdate[key] < CACHE_TTL)) {
          StrategyAdvisor.data[key] = j.data[key];
          StrategyAdvisor.lastUpdate[key] = j.lastUpdate[key];
        }
      });
    } catch (_) {}
  }
  function saveCache() {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        data: StrategyAdvisor.data,
        lastUpdate: StrategyAdvisor.lastUpdate
      }));
    } catch (_) {}
  }

  // -------- Run a frame --------
  async function run(frameId) {
    const frame = FRAMES.find(f => f.id === frameId);
    if (!frame) return;
    StrategyAdvisor.loading[frameId] = true;
    renderFrame(frameId);

    try {
      const prompt = frame.prompt + `\n\nReturn EXACTLY 4 insights. Keep each 'detail' under 350 characters. Respond ONLY with a JSON code block, no commentary:
\`\`\`json
{
  "frame": "${frameId}",
  "generated_at": "ISO",
  "insights": [
    {"title":"sharp headline","detail":"<=350 chars with specifics","pillar":"secure|coord|bio|clinical|cross","urgency":1-10,"confidence":1-10,"kpi":"concrete metric","tags":["signal","risk","move","opportunity"]}
  ],
  "synthesis": "<=350 char strategic synthesis",
  "questions_for_atom": ["q1","q2","q3"]
}
\`\`\`
Valid JSON only. No text outside the code block.`;

      const res = await fetch('/api/atom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          mode: 'reasoning',
          context: buildContext(),
          stream: false
        })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const text = j.choices?.[0]?.message?.content || '';
      const citations = j.citations || [];

      const parsed = parseJson(text);
      if (!parsed || !parsed.insights) throw new Error('No structured insights returned');

      StrategyAdvisor.data[frameId] = { ...parsed, citations };
      StrategyAdvisor.lastUpdate[frameId] = Date.now();
      saveCache();
    } catch (e) {
      console.warn('Strategy frame failed:', e);
      StrategyAdvisor.data[frameId] = {
        error: String(e.message || e),
        insights: []
      };
    } finally {
      StrategyAdvisor.loading[frameId] = false;
      renderFrame(frameId);
      renderDecisionMatrix();
    }
  }

  async function refreshAll() {
    pushToast('Refreshing all 6 strategic frames · this may take 60-90 seconds');
    for (const f of FRAMES) {
      await run(f.id);
    }
    pushToast('All frames refreshed');
  }

  // -------- Render active frame --------
  function renderFrame(frameId) {
    const host = document.getElementById('strategy-frame-body');
    if (!host) return;
    const frame = FRAMES.find(f => f.id === frameId);
    const data = StrategyAdvisor.data[frameId];
    const loading = StrategyAdvisor.loading[frameId];
    const ts = StrategyAdvisor.lastUpdate[frameId];

    if (loading) {
      host.innerHTML = `
        <div class="strategy-loading">
          <div class="strategy-loading-orb">
            <span></span><span></span><span></span>
          </div>
          <div class="strategy-loading-label">ATOM reasoning through <strong>${frame.label}</strong>…</div>
          <div class="strategy-loading-sub">sonar-reasoning-pro · scanning global signals · mapping to Nirmata pillars</div>
        </div>`;
      return;
    }

    if (!data) {
      host.innerHTML = `
        <div class="strategy-empty">
          <div class="strategy-empty-icon">${frame.icon}</div>
          <div class="strategy-empty-title">${frame.label}</div>
          <div class="strategy-empty-sub">Generate a fresh strategic briefing for this lens.</div>
          <button class="strategy-btn strategy-btn-primary" id="strategy-run-${frameId}">GENERATE ${frame.label.toUpperCase()}</button>
        </div>`;
      document.getElementById(`strategy-run-${frameId}`)?.addEventListener('click', () => run(frameId));
      return;
    }

    if (data.error) {
      host.innerHTML = `
        <div class="strategy-empty">
          <div class="strategy-empty-icon">⚠</div>
          <div class="strategy-empty-title">Frame generation failed</div>
          <div class="strategy-empty-sub" style="color:#ff7a90">${escapeHtml(data.error)}</div>
          <button class="strategy-btn strategy-btn-primary" id="strategy-retry-${frameId}">RETRY</button>
        </div>`;
      document.getElementById(`strategy-retry-${frameId}`)?.addEventListener('click', () => run(frameId));
      return;
    }

    const relTime = ts ? formatRel(ts) : 'unknown';
    host.innerHTML = `
      <div class="strategy-frame-meta">
        <div>
          <span class="strategy-frame-meta-icon">${frame.icon}</span>
          <strong>${frame.label}</strong>
          <span class="strategy-frame-meta-time">Updated ${relTime}</span>
        </div>
        <button class="strategy-btn strategy-btn-ghost" id="strategy-frame-refresh">↻ REFRESH THIS FRAME</button>
      </div>

      ${data.synthesis ? `
        <div class="strategy-synthesis">
          <div class="strategy-synthesis-label">◆ SYNTHESIS FOR BEN &amp; JOEL</div>
          <div class="strategy-synthesis-body">${escapeHtml(data.synthesis)}</div>
        </div>
      ` : ''}

      <div class="strategy-insights">
        ${(data.insights || []).map((ins, i) => renderInsight(ins, i, frame)).join('')}
      </div>

      ${data.questions_for_atom && data.questions_for_atom.length ? `
        <div class="strategy-followups">
          <div class="strategy-followups-label">◆ FOLLOWUP QUESTIONS TO ASK ATOM</div>
          ${data.questions_for_atom.map(q => `
            <button class="strategy-followup" data-q="${escapeAttr(q)}">→ ${escapeHtml(q)}</button>
          `).join('')}
        </div>
      ` : ''}

      ${data.citations && data.citations.length ? `
        <div class="strategy-citations">
          <span class="strategy-citations-label">SOURCES:</span>
          ${data.citations.slice(0, 8).map((c, i) =>
            `<a href="${escapeAttr(c)}" target="_blank" rel="noopener">[${i+1}]</a>`).join(' ')}
        </div>
      ` : ''}
    `;

    document.getElementById('strategy-frame-refresh').addEventListener('click', () => run(frameId));
    host.querySelectorAll('.strategy-followup').forEach(btn => {
      btn.addEventListener('click', () => {
        if (window.ATOM && ATOM.ask) ATOM.ask(btn.dataset.q, { mode: 'reasoning' });
      });
    });
    host.querySelectorAll('.strategy-insight').forEach(card => {
      card.addEventListener('click', () => {
        const title = card.dataset.title || '';
        const detail = card.dataset.detail || '';
        const prompt = `Drill deeper on this Nirmata strategic insight: "${title}". Context: ${detail}. Give me: (1) the 3 sharpest sub-questions to answer next, (2) 2 concrete next-90-day actions Ben or Joel should take, (3) 1 non-obvious risk we might be missing.`;
        if (window.ATOM && ATOM.ask) ATOM.ask(prompt, { mode: 'reasoning' });
      });
    });
  }

  function renderInsight(ins, i, frame) {
    const pillar = PILLARS.find(p => p.key === ins.pillar) || { name: 'Cross-pillar', color: '#7d8ba0', icon: '◆' };
    const urgency = Math.max(1, Math.min(10, ins.urgency || 5));
    const confidence = Math.max(1, Math.min(10, ins.confidence || 5));
    const urgencyBar = Math.round(urgency * 10);
    return `
      <div class="strategy-insight" style="--pillar:${pillar.color}"
           data-title="${escapeAttr(ins.title || '')}"
           data-detail="${escapeAttr(ins.detail || '')}">
        <div class="strategy-insight-head">
          <span class="strategy-insight-num">${String(i+1).padStart(2, '0')}</span>
          <span class="strategy-insight-pillar" title="${escapeAttr(pillar.name)}">
            ${pillar.icon} ${escapeHtml(pillar.name)}
          </span>
          <span class="strategy-insight-urgency" title="Urgency ${urgency}/10">
            <span class="strategy-urgency-bar" style="width:${urgencyBar}%"></span>
            <span class="strategy-urgency-num">U${urgency}</span>
          </span>
        </div>
        <div class="strategy-insight-title">${escapeHtml(ins.title || 'Untitled')}</div>
        <div class="strategy-insight-detail">${escapeHtml(ins.detail || '')}</div>
        ${ins.kpi ? `<div class="strategy-insight-kpi"><span class="kpi-tag">KPI</span> ${escapeHtml(ins.kpi)}</div>` : ''}
        <div class="strategy-insight-foot">
          ${(ins.tags || []).map(t => `<span class="strategy-tag">${escapeHtml(t)}</span>`).join('')}
          <span class="strategy-conf">confidence ${confidence}/10</span>
          <span class="strategy-drill">→ Ask ATOM to drill deeper</span>
        </div>
      </div>
    `;
  }

  function renderDecisionMatrix() {
    const host = document.getElementById('strategy-decision-matrix');
    if (!host) return;
    // Aggregate all insights across frames
    const all = [];
    Object.entries(StrategyAdvisor.data).forEach(([frameId, d]) => {
      (d?.insights || []).forEach(ins => {
        all.push({ frameId, ...ins });
      });
    });
    if (!all.length) {
      host.innerHTML = `<div class="strategy-matrix-empty">Run at least one frame to populate the decision matrix.</div>`;
      return;
    }
    // Sort by urgency * confidence
    all.sort((a, b) => ((b.urgency||5)*(b.confidence||5)) - ((a.urgency||5)*(a.confidence||5)));
    const top = all.slice(0, 12);
    host.innerHTML = `
      <div class="strategy-matrix-grid">
        ${top.map(item => {
          const pillar = PILLARS.find(p => p.key === item.pillar) || { color: '#7d8ba0', icon: '◆' };
          const frame = FRAMES.find(f => f.id === item.frameId);
          const score = (item.urgency||5) * (item.confidence||5);
          return `
            <div class="strategy-matrix-item" style="--pillar:${pillar.color}"
                 data-title="${escapeAttr(item.title||'')}"
                 data-detail="${escapeAttr(item.detail||'')}">
              <div class="strategy-matrix-frame">${frame?.icon || '◆'} ${escapeHtml(frame?.label || '')}</div>
              <div class="strategy-matrix-title">${escapeHtml(item.title || '')}</div>
              <div class="strategy-matrix-meta">
                <span class="strategy-matrix-score">SCORE ${score}</span>
                <span>${pillar.icon}</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
    host.querySelectorAll('.strategy-matrix-item').forEach(el => {
      el.addEventListener('click', () => {
        const t = el.dataset.title;
        const d = el.dataset.detail;
        if (window.ATOM && ATOM.ask) {
          ATOM.ask(`Give me the sharpest tactical playbook for this Nirmata insight — "${t}". Detail: ${d}. Focus on what Ben and Joel should do in the next 30 days.`, { mode: 'reasoning' });
        }
      });
    });
  }

  // -------- Helpers --------
  function parseJson(text) {
    // Try to extract JSON from ```json fenced block or first {...}
    // Strip any <think>...</think> blocks the reasoning model may emit
    const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '');
    const fenced = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : cleaned;
    const start = candidate.indexOf('{');
    if (start < 0) return null;
    // Find matching closing brace
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    // Try full slice first
    if (end > 0) {
      try { return JSON.parse(candidate.slice(start, end)); } catch (e) { /* fall through */ }
    }
    // Truncation salvage: JSON was cut off. Close open structures gracefully.
    let slice = candidate.slice(start);
    // Trim trailing partial token: cut at last complete `}` or `]`
    let lastClose = Math.max(slice.lastIndexOf('}'), slice.lastIndexOf(']'));
    if (lastClose > 0) slice = slice.slice(0, lastClose + 1);
    // Balance braces/brackets
    let openB = 0, openS = 0, inS = false, es = false;
    for (let i = 0; i < slice.length; i++) {
      const c = slice[i];
      if (es) { es = false; continue; }
      if (c === '\\') { es = true; continue; }
      if (c === '"') { inS = !inS; continue; }
      if (inS) continue;
      if (c === '{') openB++; else if (c === '}') openB--;
      if (c === '[') openS++; else if (c === ']') openS--;
    }
    // Remove any trailing comma before closing
    slice = slice.replace(/,\s*$/, '');
    while (openS-- > 0) slice += ']';
    while (openB-- > 0) slice += '}';
    try { return JSON.parse(slice); } catch (e) {
      console.warn('JSON parse failed after salvage', e);
      return null;
    }
  }

  function buildContext() {
    const critical = (window.COUNTRIES || [])
      .filter(c => c.ipc >= 4)
      .slice(0, 10)
      .map(c => `${c.name}(IPC${c.ipc})`)
      .join(', ');
    const commod = window.COMMODITY_PRICES
      ? Object.entries(window.COMMODITY_PRICES).slice(0, 5).map(([k, v]) =>
          `${k}:${v.current||v.price||'n/a'}`).join(' ')
      : '';
    return `Active app: AGRI-CRISIS NEXUS. Current top crisis zones: ${critical}. Commodity refs: ${commod}. User = Ben O'Leary (CQO, Nirmata Holdings) + Joel Bedard (Co-founder). Task: Nirmata Strategy Advisor — surface high-leverage insights tied to Nirmata's four pillars: Secure Infrastructure, Coordination Layer, Regenerative Biology, Clinical Intelligence.`;
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
    if (window.ATOM && typeof ATOM.pushSystem === 'function') {
      ATOM.pushSystem(msg);
      return;
    }
    // Fallback toast
    let t = document.getElementById('strategy-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'strategy-toast';
      t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.85);color:#00ffb3;padding:10px 20px;border-radius:8px;border:1px solid rgba(0,255,179,.4);font-family:"Space Mono",monospace;font-size:12px;z-index:99999;transition:opacity .3s;pointer-events:none';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3200);
  }

  // -------- Init hook --------
  window.NirmataStrategy.mount = mount;
  window.NirmataStrategy.run = run;
})();
