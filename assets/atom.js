/* ==============================================================
   ATOM — Category-defining AI agent for AGRI-CRISIS NEXUS
   Streaming Perplexity API, tool-calling, artifact generation,
   context-aware, memory-persistent (session), voice-ready
   ============================================================== */
(function(){
  'use strict';

  // -------- State --------
  const ATOM = {
    open: false,
    expanded: false,
    mode: 'chat', // chat | reasoning | deep | quick | build
    history: [],
    thinking: false,
    lastCitations: [],
    artifacts: [],
    liveData: {}, // live-refreshed data from Perplexity
    autoRefresh: false,
    subscribers: {},
    buildUnlocked: false, // BUILD MODE authorization gate
    buildPrincipal: null, // 'ben' | 'joel' once unlocked
    buildHistory: [] // { ts, summary, plan, applied }
  };
  window.ATOM = ATOM;

  // -------- Suggested prompts (context-aware) --------
  const SUGGESTIONS = {
    chat: [
      "What are the top 3 crisis inflection points right now?",
      "Correlate current wheat prices to Ukraine conflict",
      "Which Nirmata portfolio solves the Sahel food crisis?",
      "Build me a briefing memo for board meeting"
    ],
    reasoning: [
      "Model 2027 food price scenario if China embargoes Australian wheat",
      "Reason through 3 chess moves Russia could play against grain markets",
      "Analyze cascade: Ogallala depletion → US corn → global protein"
    ],
    deep: [
      "Full deep-dive on regenerative-biotech opportunities for Nirmata Holdings",
      "Comprehensive threat map for post-quantum crypto in food supply",
      "Deep research: biostimulants TAM 2026-2030 with primary sources"
    ],
    quick: [
      "Latest wheat futures price",
      "Any new grain export bans this week?",
      "IPC phase update for Sudan and Gaza"
    ],
    build: [
      "Add a new KPI card for global refugee count on the map module",
      "Change the color of the classification banner to gold",
      "Add a search filter to the timeline module",
      "Insert a new tab for supply chain risks",
      "Show recent change history"
    ]
  };

  // -------- BUILD MODE unlock codes (client-side gate; real auth is passphrase confirmation) --------
  const BUILD_UNLOCK_CODES = {
    'BEN-QUANTUM-2026': 'ben',
    'JOEL-BEDARD-COFOUNDER': 'joel',
    'NIRMATA-BUILD-OVERRIDE': 'admin'
  };

  // -------- Boot UI --------
  function bootAtom() {
    if (document.getElementById('atom-orb')) return;

    // Aurora + particle layers (behind everything)
    const aurora = document.createElement('div');
    aurora.className = 'aurora-layer';
    aurora.innerHTML = '<div class="aurora-blob b1"></div><div class="aurora-blob b2"></div><div class="aurora-blob b3"></div>';
    document.body.appendChild(aurora);

    const particleCanvas = document.createElement('canvas');
    particleCanvas.id = 'particle-canvas';
    document.body.appendChild(particleCanvas);
    initParticles(particleCanvas);

    // Orb
    const orbWrap = document.createElement('div');
    orbWrap.className = 'atom-orb-wrap';
    orbWrap.innerHTML = `
      <div id="atom-orb" class="atom-orb" title="Ask ATOM (⌘K or A)">
        <span class="atom-electron"></span>
        <span class="atom-electron"></span>
        <span class="atom-electron"></span>
        <span class="atom-glyph">A</span>
      </div>
      <div class="atom-orb-label">ASK ATOM · ⌘K</div>
    `;
    document.body.appendChild(orbWrap);

    // Panel
    const panel = document.createElement('div');
    panel.className = 'atom-panel';
    panel.id = 'atom-panel';
    panel.innerHTML = `
      <div class="atom-panel-header">
        <div class="atom-mini-orb"></div>
        <div class="atom-title-block">
          <div class="t1">ATOM · STRATEGIC AGENT</div>
          <div class="t2">ONLINE · SONAR · NIRMATA CONTEXT LOADED</div>
        </div>
        <div class="atom-controls">
          <button class="atom-btn-icon" id="atom-expand" title="Expand">⛶</button>
          <button class="atom-btn-icon" id="atom-clear" title="Clear">⌫</button>
          <button class="atom-btn-icon" id="atom-close" title="Close">✕</button>
        </div>
      </div>
      <div class="atom-mode-bar" id="atom-mode-bar">
        <button class="atom-mode-btn active" data-mode="chat">◉ CHAT</button>
        <button class="atom-mode-btn" data-mode="reasoning">⇌ REASONING</button>
        <button class="atom-mode-btn" data-mode="deep">▲ DEEP RESEARCH</button>
        <button class="atom-mode-btn" data-mode="quick">⚡ QUICK</button>
        <button class="atom-mode-btn atom-mode-build" data-mode="build" title="Self-editing mode">◆ BUILD</button>
      </div>
      <div class="atom-messages" id="atom-messages"></div>
      <div class="atom-input-wrap">
        <div class="atom-suggestions" id="atom-suggestions"></div>
        <div class="atom-input-row">
          <textarea class="atom-input" id="atom-input" rows="1"
            placeholder="Ask ATOM anything… analyze, forecast, build a module, correlate to Nirmata"></textarea>
          <button class="atom-send" id="atom-send" title="Send">→</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // Wire events
    document.getElementById('atom-orb').addEventListener('click', toggle);
    document.getElementById('atom-close').addEventListener('click', close);
    document.getElementById('atom-clear').addEventListener('click', clearChat);
    document.getElementById('atom-expand').addEventListener('click', expandToggle);
    document.getElementById('atom-send').addEventListener('click', send);

    const input = document.getElementById('atom-input');
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    input.addEventListener('input', e => {
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px';
    });

    document.querySelectorAll('.atom-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const newMode = btn.dataset.mode;
        // BUILD MODE requires unlock
        if (newMode === 'build' && !ATOM.buildUnlocked) {
          promptBuildUnlock();
          return;
        }
        document.querySelectorAll('.atom-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        ATOM.mode = newMode;
        renderSuggestions();
        if (newMode === 'build') {
          announceBuildMode();
        }
      });
    });

    // Global hotkeys
    document.addEventListener('keydown', e => {
      const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (cmdK) { e.preventDefault(); toggle(); input.focus(); }
      // Bare "A" opens when not typing in a field
      if (e.key.toLowerCase() === 'a' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        if (!ATOM.open) toggle();
        input.focus();
      }
      if (e.key === 'Escape' && ATOM.open) close();
    });

    // Welcome message
    pushSystem('ATOM online · Nirmata portfolio loaded · Perplexity Sonar connected');
    pushAssistant(
      `<strong>Greetings, Chief Quantum Officer.</strong><br>
       I'm <strong>ATOM</strong> — your strategic intelligence agent embedded across all 11 modules of AGRI-CRISIS NEXUS.<br><br>
       I can:<br>
       • <em>Analyze</em> live crisis intelligence via Perplexity's Sonar family (chat / reasoning / deep research).<br>
       • <em>Forecast</em> geopolitical, commodity, and food-supply scenarios with confidence scores.<br>
       • <em>Correlate</em> every crisis vector to Nirmata Holdings' strategic pillars — secure infrastructure, coordination layer, regenerative biology, clinical intelligence.<br>
       • <em>Build</em> new modules, dashboards, briefings, memos, and chess moves inline — try "build me a…"<br><br>
       <strong>Try:</strong> "Build a memo comparing current 2026 food shocks to 1973 oil crisis" or "Predict wheat price if Black Sea corridor collapses".`,
      []
    );

    renderSuggestions();
  }

  // -------- UI helpers --------
  function toggle() {
    ATOM.open = !ATOM.open;
    const panel = document.getElementById('atom-panel');
    const orb = document.getElementById('atom-orb');
    if (ATOM.open) {
      panel.classList.add('open');
      orb.style.opacity = '0';
      orb.style.pointerEvents = 'none';
    } else {
      panel.classList.remove('open');
      orb.style.opacity = '1';
      orb.style.pointerEvents = 'auto';
    }
  }
  function close() { if (ATOM.open) toggle(); }
  function expandToggle() {
    ATOM.expanded = !ATOM.expanded;
    document.getElementById('atom-panel').classList.toggle('expanded', ATOM.expanded);
  }
  function clearChat() {
    ATOM.history = [];
    document.getElementById('atom-messages').innerHTML = '';
    pushSystem('Conversation cleared · Context preserved');
  }
  function renderSuggestions() {
    const box = document.getElementById('atom-suggestions');
    if (!box) return;
    const list = SUGGESTIONS[ATOM.mode] || SUGGESTIONS.chat;
    box.innerHTML = list.map(s =>
      `<div class="atom-suggest-chip">${s}</div>`
    ).join('');
    box.querySelectorAll('.atom-suggest-chip').forEach(el => {
      el.addEventListener('click', () => {
        document.getElementById('atom-input').value = el.textContent;
        send();
      });
    });
  }

  function pushSystem(text) {
    const box = document.getElementById('atom-messages');
    const el = document.createElement('div');
    el.className = 'atom-msg system';
    el.textContent = text;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }
  function pushUser(text) {
    const box = document.getElementById('atom-messages');
    const el = document.createElement('div');
    el.className = 'atom-msg user';
    el.textContent = text;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }
  function pushAssistant(html, citations) {
    const box = document.getElementById('atom-messages');
    const el = document.createElement('div');
    el.className = 'atom-msg assistant';
    el.innerHTML = html + (citations && citations.length
      ? `<div class="citations">${citations.slice(0,6).map((c,i)=>`<a href="${c}" target="_blank" rel="noopener">[${i+1}]</a>`).join('')}</div>`
      : '');
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }
  function pushTyping() {
    const box = document.getElementById('atom-messages');
    const el = document.createElement('div');
    el.className = 'atom-msg assistant';
    el.id = 'atom-typing-msg';
    el.innerHTML = '<span class="atom-typing"><span></span><span></span><span></span></span>';
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }

  // -------- Context assembly (feed ATOM current app state) --------
  function buildAppContext() {
    const active = document.querySelector('.nav-item.active')?.getAttribute('data-tab')
      || document.querySelector('.tab-item.active')?.getAttribute('data-tab')
      || 'map';
    const filters = {
      continent: document.getElementById('filter-continent')?.value || 'all',
      severity: document.getElementById('filter-severity')?.value || 'all',
      search: document.getElementById('filter-search')?.value || ''
    };
    const criticalCountries = (window.COUNTRIES || [])
      .filter(c => c.hungerPct > 30 || (c.ipc && c.ipc >= 3))
      .slice(0, 8)
      .map(c => `${c.name} (IPC${c.ipc}, hunger ${c.hungerPct}%)`)
      .join(', ');
    const priceSummary = window.COMMODITY_PRICES
      ? Object.entries(window.COMMODITY_PRICES).slice(0,5).map(([k,v]) =>
          `${k}: ${v.current||v.price||'n/a'}`).join(' · ')
      : '';
    const liveData = ATOM.liveData;
    const liveSummary = Object.keys(liveData).length
      ? `\nLIVE (last refresh): ${Object.entries(liveData).map(([k,v]) => `${k}: ${typeof v==='string'?v.slice(0,120):JSON.stringify(v).slice(0,120)}`).join(' | ')}`
      : '';

    return `Active module: ${active}. Filters: ${JSON.stringify(filters)}.
Top critical countries in dataset: ${criticalCountries}.
Baseline commodity ref: ${priceSummary}.${liveSummary}
Nirmata Holdings pillars: (1) Secure Infrastructure (post-quantum crypto + provenance), (2) Coordination Layer (human-centered OS for field ops), (3) Regenerative Biology (soil, microbiome, biotech), (4) Clinical Intelligence (decision AI for famine, malnutrition, livestock).
User: Chief Quantum Officer Ben O'Leary.`;
  }

  // -------- Send message (streaming) --------
  async function send() {
    const input = document.getElementById('atom-input');
    const text = input.value.trim();
    if (!text || ATOM.thinking) return;

    pushUser(text);
    ATOM.history.push({ role: 'user', content: text });
    input.value = '';
    input.style.height = 'auto';
    ATOM.thinking = true;
    document.getElementById('atom-send').disabled = true;
    document.getElementById('atom-orb').classList.add('speaking');
    const typingEl = pushTyping();

    try {
      const res = await fetch('/api/atom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: ATOM.history.slice(-10),
          mode: ATOM.mode,
          context: buildAppContext(),
          stream: true
        })
      });

      if (!res.ok) throw new Error('ATOM proxy returned ' + res.status);
      if (!res.body) throw new Error('No stream body');

      // Remove typing, create empty assistant msg to stream into
      typingEl.remove();
      const assistantEl = pushAssistant('', []);
      let fullText = '';
      let citations = [];

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            if (j.citations && j.citations.length) citations = j.citations;
            const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content;
            if (delta) {
              fullText += delta;
              renderStreamingMsg(assistantEl, fullText, citations);
            }
          } catch (_) { /* skip malformed */ }
        }
      }

      ATOM.lastCitations = citations;
      ATOM.history.push({ role: 'assistant', content: fullText });

      // Extract & process artifacts
      const artifacts = extractArtifacts(fullText);
      if (artifacts.length) {
        artifacts.forEach(a => mountArtifact(assistantEl, a));
      }
      // Extract & process build plans (BUILD MODE)
      const buildPlans = extractBuildPlans(fullText);
      if (buildPlans.length) {
        buildPlans.forEach(p => mountBuildPlan(assistantEl, p));
      }

    } catch (err) {
      console.error('ATOM error:', err);
      document.getElementById('atom-typing-msg')?.remove();
      pushAssistant(`<em>Signal degraded.</em> ${String(err.message || err)}. Retrying may succeed — check console.`, []);
    } finally {
      ATOM.thinking = false;
      document.getElementById('atom-send').disabled = false;
      document.getElementById('atom-orb').classList.remove('speaking');
    }
  }

  // -------- Markdown-lite rendering ---------
  function renderStreamingMsg(el, text, citations) {
    let html = mdRender(text);
    // Split out <think>...</think> from sonar-reasoning
    html = html.replace(/&lt;think&gt;([\s\S]*?)&lt;\/think&gt;/g, (_, t) =>
      `<div class="think-block">${t.trim()}</div>`);
    // Also fenced code preserved
    if (citations && citations.length) {
      html += `<div class="citations">${citations.slice(0,6).map((c,i)=>`<a href="${c}" target="_blank" rel="noopener">[${i+1}]</a>`).join('')}</div>`;
    }
    el.innerHTML = html;
    const box = document.getElementById('atom-messages');
    box.scrollTop = box.scrollHeight;
  }
  function mdRender(text) {
    // Escape then re-apply targeted markdown
    let s = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    // Code fences (preserve for artifact extraction later — display as-is)
    s = s.replace(/```(atom-artifact)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<div style="font-family:'Space Mono',monospace;font-size:10px;color:#00ffb3;background:rgba(0,255,179,.06);padding:8px;border-radius:6px;border:1px dashed rgba(0,255,179,.3);margin:6px 0;">◉ ARTIFACT: ${escapeHtml(extractArtifactTitle(code))}</div>`);
    // BUILD MODE plans — hide the raw JSON block, will be mounted as a rich UI below
    s = s.replace(/```(atom-build)\s*\n([\s\S]*?)```/g, (_, lang, code) =>
      `<div style="font-family:'Space Mono',monospace;font-size:10px;color:#bf5fff;background:rgba(191,95,255,.06);padding:8px;border-radius:6px;border:1px dashed rgba(191,95,255,.3);margin:6px 0;">◆ BUILD PLAN GENERATED — rendering preview below…</div>`);
    s = s.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre style="background:rgba(0,0,0,.4);padding:10px;border-radius:6px;overflow-x:auto;font-family:'Space Mono',monospace;font-size:11px;color:#00ffb3;">${code}</pre>`);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    // Bullets
    s = s.replace(/^(\s*)[-•]\s+(.+)$/gm, '<li>$2</li>');
    s = s.replace(/(<li>[\s\S]+?<\/li>(?:\n?<li>[\s\S]+?<\/li>)*)/g, '<ul>$1</ul>');
    // Numbered lists
    s = s.replace(/^\s*\d+\.\s+(.+)$/gm, '<div style="margin:4px 0">→ $1</div>');
    // Citations [n]
    s = s.replace(/\[(\d+)\]/g, '<sup style="color:#00e5ff">[$1]</sup>');
    // Line breaks
    s = s.replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>');
    return s;
  }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function extractArtifactTitle(code) {
    try { const j = JSON.parse(code); return j.title || j.type || 'artifact'; } catch { return 'artifact'; }
  }

  // -------- Artifact system --------
  function extractArtifacts(text) {
    const out = [];
    const rx = /```atom-artifact\n([\s\S]*?)```/g;
    let m;
    while ((m = rx.exec(text)) !== null) {
      try {
        const j = JSON.parse(m[1]);
        out.push(j);
      } catch (e) { console.warn('Artifact parse failed', e); }
    }
    return out;
  }
  function mountArtifact(afterEl, artifact) {
    const wrap = document.createElement('div');
    wrap.className = 'atom-artifact';
    const artifactId = 'atom-artifact-' + Date.now() + '-' + Math.random().toString(36).slice(2,7);
    wrap.innerHTML = `
      <div class="atom-artifact-header">
        <span class="badge">◉ ${escapeHtml(artifact.type || 'artifact').toUpperCase()}</span>
        <strong>${escapeHtml(artifact.title || 'Untitled')}</strong>
        <div class="actions">
          <button data-act="deploy">DEPLOY TO STUDIO</button>
          <button data-act="copy">COPY HTML</button>
        </div>
      </div>
      <div class="atom-artifact-body" id="${artifactId}"></div>
    `;
    afterEl.after(wrap);
    const body = wrap.querySelector('.atom-artifact-body');
    body.innerHTML = artifact.html || '<em style="color:#7d8ba0">(no HTML in artifact)</em>';
    // Run script if provided
    if (artifact.script) {
      try {
        window.ATOM_ARTIFACT_ROOT = body;
        new Function(artifact.script)();
      } catch (e) { console.warn('Artifact script failed', e); }
    }
    wrap.querySelector('[data-act="deploy"]').addEventListener('click', () => {
      deployArtifactToStudio(artifact);
    });
    wrap.querySelector('[data-act="copy"]').addEventListener('click', () => {
      navigator.clipboard?.writeText(artifact.html || '');
    });
    ATOM.artifacts.push(artifact);
  }
  // -------- BUILD MODE ---------
  function promptBuildUnlock() {
    const box = document.getElementById('atom-messages');
    // If a prompt panel is already visible, focus its input
    const existing = document.getElementById('atom-build-unlock');
    if (existing) { existing.querySelector('input')?.focus(); return; }
    if (!ATOM.open) toggle();
    const el = document.createElement('div');
    el.id = 'atom-build-unlock';
    el.className = 'atom-msg assistant';
    el.innerHTML = `
      <div style="padding:14px;border:1px solid rgba(191,95,255,.45);border-radius:10px;background:linear-gradient(135deg,rgba(191,95,255,.08),rgba(0,229,255,.05));">
        <div style="font-family:'Clash Display',sans-serif;font-size:13px;letter-spacing:.18em;color:#bf5fff;margin-bottom:8px;">◆ BUILD MODE · AUTHORIZATION REQUIRED</div>
        <div style="font-size:12px;color:#c9d3e2;line-height:1.5;margin-bottom:12px;">
          BUILD MODE lets ATOM propose live changes to this application's source code. Only <strong>Ben O'Leary</strong> (CQO) and <strong>Joel Bedard</strong> (co-founder) are authorized.<br><br>
          Enter your unlock code to continue. Codes are private — do not share.
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <input id="atom-build-unlock-input" type="password" placeholder="Unlock code"
            style="flex:1;padding:10px 12px;background:rgba(0,0,0,.5);border:1px solid rgba(191,95,255,.4);border-radius:6px;color:#fff;font-family:'Space Mono',monospace;font-size:13px;">
          <button id="atom-build-unlock-submit"
            style="padding:10px 16px;background:linear-gradient(135deg,#bf5fff,#00e5ff);border:none;border-radius:6px;color:#0a0e1a;font-family:'Clash Display',sans-serif;font-size:12px;letter-spacing:.12em;font-weight:600;cursor:pointer;">UNLOCK</button>
        </div>
        <div id="atom-build-unlock-msg" style="margin-top:8px;font-size:11px;color:#ff2d55;min-height:14px;"></div>
      </div>
    `;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    const input = document.getElementById('atom-build-unlock-input');
    const submit = document.getElementById('atom-build-unlock-submit');
    const msg = document.getElementById('atom-build-unlock-msg');
    setTimeout(() => input.focus(), 50);
    const attempt = () => {
      const code = (input.value || '').trim().toUpperCase();
      const principal = BUILD_UNLOCK_CODES[code];
      if (principal) {
        ATOM.buildUnlocked = true;
        ATOM.buildPrincipal = principal;
        el.remove();
        // Activate build mode
        document.querySelectorAll('.atom-mode-btn').forEach(b =>
          b.classList.toggle('active', b.dataset.mode === 'build'));
        ATOM.mode = 'build';
        renderSuggestions();
        announceBuildMode();
      } else {
        msg.textContent = 'Invalid unlock code. Access denied.';
        input.value = '';
        input.focus();
      }
    };
    submit.addEventListener('click', attempt);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
  }

  function announceBuildMode() {
    const principalName = ATOM.buildPrincipal === 'ben' ? 'Ben O\'Leary (CQO)'
      : ATOM.buildPrincipal === 'joel' ? 'Joel Bedard (Co-founder)'
      : 'Administrator';
    pushAssistant(`
      <div style="padding:12px 14px;border:1px solid rgba(191,95,255,.4);border-radius:10px;background:rgba(191,95,255,.06);">
        <div style="font-family:'Clash Display',sans-serif;font-size:12px;letter-spacing:.18em;color:#bf5fff;margin-bottom:6px;">◆ BUILD MODE · UNLOCKED</div>
        <div style="font-size:12px;color:#c9d3e2;line-height:1.5;">
          Authenticated as <strong>${escapeHtml(principalName)}</strong>. Describe any change you want made to the application — add a feature, modify a module, change styling, insert new data. I will:<br><br>
          → Analyze the current codebase<br>
          → Emit a precise edit plan (file + find/replace) with a risk rating<br>
          → Preview the diff for your review<br>
          → Provide copy-paste patches or downloadable files<br><br>
          <strong>Try:</strong> "Add a new KPI card showing displaced-population count on the map module."<br>
          <button data-act="show-history" style="margin-top:10px;padding:6px 12px;background:rgba(0,255,179,.1);border:1px solid rgba(0,255,179,.3);border-radius:6px;color:#00ffb3;font-family:'Space Mono',monospace;font-size:11px;cursor:pointer;">☰ SHOW CHANGE HISTORY</button>
        </div>
      </div>
    `, []);
    const box = document.getElementById('atom-messages');
    const btn = box.querySelector('[data-act="show-history"]');
    btn?.addEventListener('click', showBuildHistory);
  }

  function loadBuildHistory() {
    try {
      const raw = sessionStorage.getItem('atom_build_history');
      if (raw) ATOM.buildHistory = JSON.parse(raw);
    } catch (_) { ATOM.buildHistory = []; }
  }
  function saveBuildHistory() {
    try {
      sessionStorage.setItem('atom_build_history', JSON.stringify(ATOM.buildHistory.slice(-30)));
    } catch (_) {}
  }
  function showBuildHistory() {
    loadBuildHistory();
    const hist = ATOM.buildHistory;
    if (!hist.length) {
      pushSystem('No change history yet in this session.');
      return;
    }
    const html = `
      <div style="padding:12px 14px;border:1px solid rgba(0,255,179,.3);border-radius:10px;background:rgba(0,0,0,.3);">
        <div style="font-family:'Clash Display',sans-serif;font-size:12px;letter-spacing:.18em;color:#00ffb3;margin-bottom:10px;">☰ CHANGE HISTORY (this session)</div>
        ${hist.slice().reverse().map((h,i) => `
          <div style="padding:8px 10px;margin-bottom:6px;background:rgba(0,255,179,.04);border-left:2px solid ${h.applied ? '#00ffb3' : '#f5c842'};border-radius:4px;">
            <div style="font-size:11px;color:#7d8ba0;font-family:'Space Mono',monospace;">${new Date(h.ts).toLocaleString()}</div>
            <div style="font-size:12px;color:#e8ecf5;margin-top:2px;">${escapeHtml(h.summary || 'change')}</div>
            <div style="font-size:10px;color:${h.applied ? '#00ffb3' : '#f5c842'};letter-spacing:.1em;margin-top:4px;">${h.applied ? '✓ MARKED APPLIED' : '○ PENDING'} · risk: ${h.risk || 'n/a'} · ${h.plan?.changes?.length || 0} file(s)</div>
          </div>
        `).join('')}
      </div>
    `;
    pushAssistant(html, []);
  }

  function extractBuildPlans(text) {
    const out = [];
    const rx = /```atom-build\s*\n([\s\S]*?)```/g;
    let m;
    while ((m = rx.exec(text)) !== null) {
      try {
        const j = JSON.parse(m[1]);
        out.push(j);
      } catch (e) {
        console.warn('Build plan parse failed', e);
      }
    }
    return out;
  }

  function mountBuildPlan(afterEl, plan) {
    const wrap = document.createElement('div');
    wrap.className = 'atom-build-plan';
    const planId = 'atom-plan-' + Date.now() + '-' + Math.random().toString(36).slice(2,7);
    const riskColor = plan.risk === 'high' ? '#ff2d55' : plan.risk === 'med' ? '#f5c842' : '#00ffb3';
    const riskLabel = (plan.risk || 'low').toUpperCase();

    // Safety pre-check
    const guardWarnings = [];
    (plan.changes || []).forEach((c, i) => {
      const combined = `${c.find || ''}\n${c.replace || ''}\n${c.content || ''}`;
      if (/PPLX_KEY|pplx-[A-Za-z0-9]{6,}|GITHUB_TOKEN|Bearer\s+[A-Za-z0-9]/.test(combined)) {
        guardWarnings.push(`Change #${i+1} appears to reference secrets/keys — blocked by safety guard.`);
      }
      if ((c.path || '').toLowerCase() === 'api/atom.js') {
        guardWarnings.push(`Change #${i+1} targets api/atom.js which is protected (self-editing the agent is disallowed).`);
      }
    });
    const isBlocked = guardWarnings.length > 0;

    wrap.innerHTML = `
      <div class="atom-build-plan-inner" id="${planId}" style="margin:12px 0;padding:14px;border:1px solid rgba(191,95,255,.4);border-radius:12px;background:linear-gradient(135deg,rgba(10,14,26,.85),rgba(191,95,255,.06));">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px;">
          <div>
            <div style="font-family:'Clash Display',sans-serif;font-size:12px;letter-spacing:.2em;color:#bf5fff;margin-bottom:4px;">◆ BUILD PLAN</div>
            <div style="font-size:14px;color:#fff;font-weight:600;">${escapeHtml(plan.summary || 'Untitled change')}</div>
          </div>
          <span style="padding:4px 10px;background:${riskColor}22;color:${riskColor};border:1px solid ${riskColor}66;border-radius:20px;font-family:'Space Mono',monospace;font-size:10px;letter-spacing:.15em;white-space:nowrap;">RISK · ${riskLabel}</span>
        </div>
        ${plan.reasoning ? `<div style="font-size:11px;color:#a8b5c8;line-height:1.5;margin-bottom:12px;padding:8px 10px;background:rgba(0,0,0,.3);border-radius:6px;border-left:2px solid #bf5fff;"><em>${escapeHtml(plan.reasoning)}</em></div>` : ''}
        ${isBlocked ? `<div style="padding:10px 12px;margin-bottom:12px;background:rgba(255,45,85,.1);border:1px solid rgba(255,45,85,.4);border-radius:6px;color:#ff2d55;font-size:11px;font-family:'Space Mono',monospace;">⚠ SAFETY GUARD TRIGGERED<br>${guardWarnings.map(w=>escapeHtml(w)).join('<br>')}</div>` : ''}
        <div style="font-family:'Space Mono',monospace;font-size:10px;color:#7d8ba0;letter-spacing:.1em;margin-bottom:8px;">${(plan.changes||[]).length} FILE CHANGE(S)</div>
        <div class="atom-build-changes"></div>
        ${plan.post_deploy_note ? `<div style="margin-top:10px;padding:8px 10px;background:rgba(0,229,255,.05);border-radius:6px;font-size:11px;color:#00e5ff;"><strong>Post-deploy:</strong> ${escapeHtml(plan.post_deploy_note)}</div>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;">
          <button data-act="copy-plan" style="padding:8px 14px;background:rgba(0,229,255,.1);border:1px solid rgba(0,229,255,.4);border-radius:6px;color:#00e5ff;font-family:'Space Mono',monospace;font-size:11px;cursor:pointer;">⧉ COPY JSON</button>
          <button data-act="download-patch" style="padding:8px 14px;background:rgba(0,255,179,.1);border:1px solid rgba(0,255,179,.4);border-radius:6px;color:#00ffb3;font-family:'Space Mono',monospace;font-size:11px;cursor:pointer;">⬇ DOWNLOAD PATCH</button>
          <button data-act="mark-applied" ${isBlocked?'disabled':''} style="padding:8px 14px;background:${isBlocked?'rgba(125,139,160,.1)':'rgba(191,95,255,.15)'};border:1px solid ${isBlocked?'rgba(125,139,160,.3)':'rgba(191,95,255,.5)'};border-radius:6px;color:${isBlocked?'#7d8ba0':'#bf5fff'};font-family:'Space Mono',monospace;font-size:11px;cursor:${isBlocked?'not-allowed':'pointer'};">✓ MARK APPLIED</button>
          <button data-act="discard" style="padding:8px 14px;background:rgba(255,45,85,.08);border:1px solid rgba(255,45,85,.3);border-radius:6px;color:#ff2d55;font-family:'Space Mono',monospace;font-size:11px;cursor:pointer;">✕ DISCARD</button>
        </div>
      </div>
    `;
    afterEl.after(wrap);

    // Render each change with a diff preview
    const changesRoot = wrap.querySelector('.atom-build-changes');
    (plan.changes || []).forEach((c, i) => {
      const ch = document.createElement('div');
      ch.style.cssText = 'margin-bottom:10px;background:rgba(0,0,0,.4);border-radius:8px;overflow:hidden;border:1px solid rgba(191,95,255,.15);';
      ch.innerHTML = `
        <div style="padding:8px 12px;background:rgba(191,95,255,.08);display:flex;justify-content:space-between;align-items:center;gap:10px;font-family:'Space Mono',monospace;font-size:11px;">
          <span><span style="color:#bf5fff;">${i+1}.</span> <span style="color:#00e5ff;">${escapeHtml(c.path||'?')}</span> <span style="color:#7d8ba0;">· ${escapeHtml(c.operation||'replace')}</span></span>
          <button data-toggle="${i}" style="background:transparent;border:1px solid rgba(255,255,255,.2);color:#c9d3e2;font-size:10px;padding:3px 8px;border-radius:4px;cursor:pointer;font-family:'Space Mono',monospace;">TOGGLE</button>
        </div>
        <div class="atom-diff" data-diff="${i}" style="padding:10px 12px;display:none;">
          ${c.anchor ? `<div style="color:#7d8ba0;font-size:10px;margin-bottom:6px;"><em>${escapeHtml(c.anchor)}</em></div>` : ''}
          ${c.find ? `<div style="font-family:'Space Mono',monospace;font-size:10px;color:#ff2d55;margin-bottom:6px;">- FIND:</div><pre style="background:rgba(255,45,85,.05);border-left:2px solid #ff2d55;padding:6px 8px;margin:0 0 8px;font-family:'Space Mono',monospace;font-size:10px;color:#ffb3c0;white-space:pre-wrap;max-height:200px;overflow:auto;">${escapeHtml(c.find)}</pre>` : ''}
          ${c.replace ? `<div style="font-family:'Space Mono',monospace;font-size:10px;color:#00ffb3;margin-bottom:6px;">+ REPLACE:</div><pre style="background:rgba(0,255,179,.05);border-left:2px solid #00ffb3;padding:6px 8px;margin:0;font-family:'Space Mono',monospace;font-size:10px;color:#b3ffe0;white-space:pre-wrap;max-height:200px;overflow:auto;">${escapeHtml(c.replace)}</pre>` : ''}
          ${c.content && !c.replace ? `<div style="font-family:'Space Mono',monospace;font-size:10px;color:#00ffb3;margin-bottom:6px;">+ CONTENT:</div><pre style="background:rgba(0,255,179,.05);border-left:2px solid #00ffb3;padding:6px 8px;margin:0;font-family:'Space Mono',monospace;font-size:10px;color:#b3ffe0;white-space:pre-wrap;max-height:200px;overflow:auto;">${escapeHtml(c.content)}</pre>` : ''}
        </div>
      `;
      changesRoot.appendChild(ch);
    });
    // Toggle diff preview
    wrap.querySelectorAll('[data-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = btn.dataset.toggle;
        const diff = wrap.querySelector(`[data-diff="${i}"]`);
        diff.style.display = diff.style.display === 'none' ? 'block' : 'none';
      });
    });
    // Auto-expand first change
    const firstDiff = wrap.querySelector('[data-diff="0"]');
    if (firstDiff) firstDiff.style.display = 'block';

    // Actions
    wrap.querySelector('[data-act="copy-plan"]').addEventListener('click', () => {
      navigator.clipboard?.writeText(JSON.stringify(plan, null, 2));
      pushSystem('Build plan JSON copied to clipboard');
    });
    wrap.querySelector('[data-act="download-patch"]').addEventListener('click', () => downloadPatch(plan));
    const markBtn = wrap.querySelector('[data-act="mark-applied"]');
    if (markBtn && !isBlocked) {
      markBtn.addEventListener('click', () => {
        loadBuildHistory();
        ATOM.buildHistory.push({
          ts: Date.now(),
          summary: plan.summary,
          risk: plan.risk,
          plan,
          applied: true,
          principal: ATOM.buildPrincipal
        });
        saveBuildHistory();
        markBtn.disabled = true;
        markBtn.textContent = '✓ APPLIED';
        markBtn.style.opacity = '.6';
        pushSystem(`Change marked applied: ${plan.summary}`);
      });
    }
    wrap.querySelector('[data-act="discard"]').addEventListener('click', () => {
      loadBuildHistory();
      ATOM.buildHistory.push({
        ts: Date.now(), summary: plan.summary, risk: plan.risk, plan,
        applied: false, discarded: true, principal: ATOM.buildPrincipal
      });
      saveBuildHistory();
      wrap.remove();
      pushSystem(`Build plan discarded: ${plan.summary}`);
    });

    // Log pending in history
    loadBuildHistory();
    ATOM.buildHistory.push({
      ts: Date.now(), summary: plan.summary, risk: plan.risk, plan,
      applied: false, principal: ATOM.buildPrincipal
    });
    saveBuildHistory();
  }

  function downloadPatch(plan) {
    // Build a human-readable patch file (unified-diff-ish)
    const lines = [];
    lines.push('# ATOM BUILD PLAN');
    lines.push('# Generated: ' + new Date().toISOString());
    lines.push('# Principal: ' + (ATOM.buildPrincipal || 'unknown'));
    lines.push('# Summary: ' + (plan.summary || ''));
    lines.push('# Risk: ' + (plan.risk || 'low'));
    lines.push('# Reasoning: ' + (plan.reasoning || ''));
    lines.push('');
    (plan.changes || []).forEach((c, i) => {
      lines.push(`## Change ${i+1}: ${c.path} (${c.operation})`);
      if (c.anchor) lines.push('# Anchor: ' + c.anchor);
      lines.push('');
      if (c.find) {
        lines.push('--- FIND ---');
        lines.push(c.find);
        lines.push('--- END FIND ---');
        lines.push('');
      }
      if (c.replace) {
        lines.push('+++ REPLACE +++');
        lines.push(c.replace);
        lines.push('+++ END REPLACE +++');
        lines.push('');
      }
      if (c.content && !c.replace) {
        lines.push('+++ CONTENT +++');
        lines.push(c.content);
        lines.push('+++ END CONTENT +++');
        lines.push('');
      }
    });
    if (plan.post_deploy_note) {
      lines.push('# Post-deploy: ' + plan.post_deploy_note);
    }
    lines.push('');
    lines.push('# --- Also embedded as JSON below for programmatic use ---');
    lines.push(JSON.stringify(plan, null, 2));
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `atom-build-${Date.now()}.patch.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    pushSystem('Patch downloaded. Apply locally, commit, and push to auto-deploy on Vercel.');
  }

  // Expose BUILD helpers on ATOM
  ATOM.buildLock = function() { ATOM.buildUnlocked = false; ATOM.buildPrincipal = null; pushSystem('BUILD MODE re-locked.'); };
  ATOM.buildShowHistory = showBuildHistory;

  function deployArtifactToStudio(artifact) {
    // Add an "Atom Studio" section to Ops Matrix (module 11) if not present
    const opsPane = document.querySelector('.module[data-mod="ops"]')
      || document.querySelector('[data-tab-pane="ops"]')
      || document.querySelector('#pane-ops');
    let studio = document.getElementById('atom-studio');
    if (!studio) {
      studio = document.createElement('div');
      studio.id = 'atom-studio';
      studio.className = 'atom-studio';
      studio.innerHTML = `
        <div class="predictor-title" style="color:#00ffb3;">◉ ATOM STUDIO · ARTIFACTS BUILT BY AGENT</div>
        <div id="atom-studio-list"></div>
      `;
      (opsPane || document.body).appendChild(studio);
    }
    const list = document.getElementById('atom-studio-list');
    const card = document.createElement('div');
    card.style.cssText = 'padding:14px;margin-top:12px;background:rgba(0,0,0,.3);border:1px solid rgba(0,255,179,.2);border-radius:10px;';
    card.innerHTML = `
      <div style="font-family:'Clash Display',sans-serif;font-size:13px;letter-spacing:.15em;color:#00ffb3;margin-bottom:8px;">
        ${escapeHtml((artifact.title || 'Artifact').toUpperCase())}
      </div>
      <div>${artifact.html || ''}</div>
    `;
    list.appendChild(card);
    if (artifact.script) {
      try {
        window.ATOM_ARTIFACT_ROOT = card;
        new Function(artifact.script)();
      } catch (e) { console.warn(e); }
    }
    pushSystem(`Artifact deployed to Studio: ${artifact.title}`);
  }

  // -------- Programmatic ATOM (invoked by other modules) --------
  ATOM.ask = function(prompt, opts) {
    if (!ATOM.open) toggle();
    document.getElementById('atom-input').value = prompt;
    if (opts?.mode) {
      document.querySelectorAll('.atom-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === opts.mode));
      ATOM.mode = opts.mode;
    }
    send();
  };
  ATOM.silentQuery = async function(prompt, mode='quick') {
    try {
      const res = await fetch('/api/atom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          mode,
          context: buildAppContext(),
          stream: false
        })
      });
      if (!res.ok) return null;
      const j = await res.json();
      return {
        text: j.choices?.[0]?.message?.content || '',
        citations: j.citations || []
      };
    } catch (e) { console.warn('silentQuery failed', e); return null; }
  };

  // -------- Particle field (background layer) --------
  function initParticles(canvas) {
    const ctx = canvas.getContext('2d');
    let w, h, particles = [];
    function resize() {
      w = canvas.width = window.innerWidth * devicePixelRatio;
      h = canvas.height = window.innerHeight * devicePixelRatio;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
    }
    window.addEventListener('resize', resize);
    resize();
    const N = window.innerWidth < 720 ? 30 : 80;
    for (let i=0; i<N; i++) {
      particles.push({
        x: Math.random()*w,
        y: Math.random()*h,
        vx: (Math.random()-0.5)*0.3 * devicePixelRatio,
        vy: (Math.random()-0.5)*0.3 * devicePixelRatio,
        r: (Math.random()*1.5 + 0.5) * devicePixelRatio,
        c: ['#00e5ff','#00ffb3','#bf5fff','#f5c842'][Math.floor(Math.random()*4)]
      });
    }
    function frame() {
      ctx.clearRect(0,0,w,h);
      particles.forEach(p => {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
        ctx.fillStyle = p.c + '99';
        ctx.shadowBlur = 8 * devicePixelRatio;
        ctx.shadowColor = p.c;
        ctx.fill();
      });
      // Link nearby
      ctx.shadowBlur = 0;
      for (let i=0; i<particles.length; i++) {
        for (let j=i+1; j<particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const d = Math.hypot(dx, dy);
          if (d < 120 * devicePixelRatio) {
            ctx.strokeStyle = `rgba(0,229,255,${(1 - d/(120*devicePixelRatio))*0.15})`;
            ctx.lineWidth = 0.5 * devicePixelRatio;
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.stroke();
          }
        }
      }
      requestAnimationFrame(frame);
    }
    frame();
  }

  // -------- Init on DOM ready --------
  function tryBoot() {
    // Wait until password gate is passed (app-shell visible)
    const shell = document.getElementById('app');
    if (!shell || shell.style.display === 'none' || getComputedStyle(shell).display === 'none') {
      setTimeout(tryBoot, 500);
      return;
    }
    bootAtom();
    // Notify other modules ATOM is ready
    window.dispatchEvent(new CustomEvent('atom:ready'));
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryBoot, 800));
  } else {
    setTimeout(tryBoot, 800);
  }
})();
