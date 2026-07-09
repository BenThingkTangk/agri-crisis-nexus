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
    mode: 'chat', // chat | reasoning | deep | quick
    history: [],
    thinking: false,
    lastCitations: [],
    artifacts: [],
    liveData: {}, // live-refreshed data from Perplexity
    autoRefresh: false,
    subscribers: {}
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
      "Full deep-dive on stem cell agriculture opportunities for RRG.bio",
      "Comprehensive threat map for post-quantum crypto in food supply",
      "Deep research: biostimulants TAM 2026-2030 with primary sources"
    ],
    quick: [
      "Latest wheat futures price",
      "Any new grain export bans this week?",
      "IPC phase update for Sudan and Gaza"
    ]
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
        document.querySelectorAll('.atom-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        ATOM.mode = btn.dataset.mode;
        renderSuggestions();
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
       • <em>Correlate</em> every crisis vector to Nirmata solutions (AntimatterAI, ThingkTangk, RRG.bio, TryClinixAI).<br>
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
Nirmata Holdings portfolio: AntimatterAI (post-quantum crypto), ThingkTangk/HumanOS (coordination OS), RRG.bio (stem cell + regenerative), TryClinixAI (clinical decision AI).
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
