/* ==============================================================
   LIVE DATA ENGINE — Continuous refresh from Perplexity Sonar
   Injects real-world data into modules on interval
   ============================================================== */
(function(){
  'use strict';

  const LIVE = {
    lastRefresh: {},
    intervals: {},
    autoOn: true,
    subscribers: []
  };
  window.LIVE = LIVE;

  // Query catalog — each field describes what to fetch and where to inject
  const QUERIES = [
    {
      key: 'wheat',
      prompt: 'Return a single JSON object (no prose, no code fence) with keys: price (number in USD/bushel), change_pct (number), trend (up|down|flat), driver (short reason string). Data: CBOT wheat front-month futures right now.',
      interval: 180000, // 3 min
      injector: 'wheat'
    },
    {
      key: 'corn',
      prompt: 'Return JSON: {price, change_pct, trend, driver}. CBOT corn front-month futures now.',
      interval: 180000,
      injector: 'corn'
    },
    {
      key: 'rice',
      prompt: 'Return JSON: {price, change_pct, trend, driver}. Thai rice 5% broken FOB price now in USD/ton.',
      interval: 300000,
      injector: 'rice'
    },
    {
      key: 'ffpi',
      prompt: 'Return JSON: {value, month, yoy_change, driver}. FAO Food Price Index most recent monthly reading.',
      interval: 600000, // 10 min
      injector: 'ffpi'
    },
    {
      key: 'headlines',
      prompt: 'Return JSON array (5 items) of the top 5 breaking agricultural crisis / food security / grain export ban / geopolitical wheat/corn stories from the last 24 hours. Each item: {title, source, region, severity (critical|high|moderate|low), tldr (one sentence)}.',
      interval: 300000,
      injector: 'headlines'
    },
    {
      key: 'ipc',
      prompt: 'Return JSON array of 8 items — current IPC/CH Phase 3+ hotspots this week: {country, phase (integer 3-5), people_affected_millions, trend (worsening|improving|stable), primary_driver}.',
      interval: 900000, // 15 min
      injector: 'ipc'
    },
    {
      key: 'chess',
      prompt: 'Return JSON array of 5 items — recent (past 72h) geopolitical moves affecting global food markets from major state actors (Russia, China, US, India, EU, Ukraine, Turkey, Iran, Saudi Arabia): {actor, move (short), target, food_impact (1-10), timestamp (ISO date)}.',
      interval: 600000,
      injector: 'chess'
    }
  ];

  // -------- JSON extractor for LLM output --------
  function extractJson(text) {
    if (!text) return null;
    // Remove code fences if present
    text = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
    // Find first { or [
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    let start;
    if (firstBrace === -1) start = firstBracket;
    else if (firstBracket === -1) start = firstBrace;
    else start = Math.min(firstBrace, firstBracket);
    if (start === -1) return null;
    // Find matching close (balance)
    const openChar = text[start];
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let end = -1;
    for (let i=start; i<text.length; i++) {
      if (text[i] === openChar) depth++;
      else if (text[i] === closeChar) {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) return null;
    try { return JSON.parse(text.slice(start, end+1)); } catch { return null; }
  }

  // -------- Injectors: apply live data to UI --------
  const INJECTORS = {
    wheat(data) {
      updateCommodity('wheat', data);
    },
    corn(data) {
      updateCommodity('corn', data);
    },
    rice(data) {
      updateCommodity('rice', data);
    },
    ffpi(data) {
      const el = document.querySelector('[data-live="ffpi-value"]');
      if (el && data.value) el.textContent = Number(data.value).toFixed(1);
      const chg = document.querySelector('[data-live="ffpi-change"]');
      if (chg && data.yoy_change != null) chg.textContent = (data.yoy_change > 0 ? '+' : '') + data.yoy_change + '% YoY';
    },
    headlines(arr) {
      if (!Array.isArray(arr) || !arr.length) return;
      // Add to ATOM live data
      window.ATOM && (window.ATOM.liveData.top_headlines = arr.map(h => `${h.title} (${h.source})`));
      // Update ticker
      const ticker = document.querySelector('.ticker-track') || document.getElementById('ticker-track');
      if (ticker) {
        const items = arr.map(h => `<span class="ticker-item"><span class="tl-bubble tl-mini tl-${sevClass(h.severity)}"><span class="tl-dot"></span></span> ${escapeHtml(h.title)} — <em>${escapeHtml(h.source)}</em></span>`).join('');
        ticker.innerHTML = items + items;
      }
      // Insert into intel feed as fresh cards (prepend)
      const feed = document.getElementById('intel-list') || document.querySelector('.intel-grid');
      if (feed && arr.length) {
        const now = new Date();
        arr.slice(0,5).forEach(h => {
          const card = document.createElement('div');
          card.className = 'intel-card fresh';
          card.innerHTML = `
            <div class="intel-head">
              <span class="tl-bubble tl-${sevClass(h.severity)}"><span class="tl-dot"></span></span>
              <span class="intel-source">${escapeHtml(h.source||'LIVE')}</span>
              <span class="intel-region">${escapeHtml(h.region||'')}</span>
              <span class="intel-time">just now · LIVE</span>
            </div>
            <div class="intel-title">${escapeHtml(h.title)}</div>
            <div class="intel-tldr">${escapeHtml(h.tldr||'')}</div>
            <div class="intel-actions">
              <button class="intel-atom-ask" data-q="Explain the strategic implications of: ${escapeAttr(h.title)}">◉ ASK ATOM</button>
            </div>
          `;
          feed.insertBefore(card, feed.firstChild);
        });
        // Wire ATOM buttons
        feed.querySelectorAll('.intel-atom-ask').forEach(b => {
          b.onclick = () => window.ATOM && window.ATOM.ask(b.dataset.q, { mode: 'reasoning' });
        });
      }
    },
    ipc(arr) {
      if (!Array.isArray(arr)) return;
      window.ATOM && (window.ATOM.liveData.ipc_hotspots = arr);
      // Update Global Status Board bubbles
      arr.forEach(item => {
        const country = (item.country||'').toLowerCase();
        document.querySelectorAll('.status-board-item').forEach(el => {
          const name = (el.querySelector('.sb-name')?.textContent || '').toLowerCase();
          if (name && country.includes(name.split(' ')[0])) {
            const bubble = el.querySelector('.tl-bubble');
            if (bubble) {
              bubble.className = 'tl-bubble tl-big tl-' + phaseClass(item.phase);
              bubble.innerHTML = '<span class="tl-dot"></span>';
            }
            const trendEl = el.querySelector('.sb-trend');
            if (trendEl) trendEl.textContent = item.trend || '';
          }
        });
      });
    },
    chess(arr) {
      if (!Array.isArray(arr)) return;
      window.ATOM && (window.ATOM.liveData.chess_moves = arr);
      const feed = document.getElementById('chess-live-feed');
      if (feed) {
        feed.innerHTML = arr.map(m => `
          <div class="chess-actor-move">
            <div class="move-time">${new Date(m.timestamp || Date.now()).toLocaleString()} · IMPACT ${m.food_impact || '?'}/10</div>
            <div><strong style="color:#ff2d55">${escapeHtml(m.actor||'')}</strong> → ${escapeHtml(m.move||'')}</div>
            <div style="font-size:10px;color:#7d8ba0">Target: ${escapeHtml(m.target||'')}</div>
          </div>
        `).join('');
      }
    }
  };

  function updateCommodity(key, data) {
    if (!data || data.price == null) return;
    // Sidebar / topbar KPIs
    document.querySelectorAll(`[data-live="${key}-price"]`).forEach(el => {
      el.textContent = '$' + Number(data.price).toFixed(2);
    });
    document.querySelectorAll(`[data-live="${key}-change"]`).forEach(el => {
      const c = Number(data.change_pct||0);
      el.textContent = (c>0?'+':'') + c.toFixed(2) + '%';
      el.style.color = c > 0 ? '#ff2d55' : c < 0 ? '#00ffb3' : '#f5c842';
    });
    document.querySelectorAll(`[data-live="${key}-driver"]`).forEach(el => {
      el.textContent = data.driver || '';
    });
    // Store in ATOM context
    window.ATOM && (window.ATOM.liveData[key] = data);
    // Also mutate the constant if present
    if (window.COMMODITY_PRICES && window.COMMODITY_PRICES[key]) {
      window.COMMODITY_PRICES[key].current = data.price;
      window.COMMODITY_PRICES[key].change = data.change_pct;
    }
  }

  function sevClass(s) {
    s = (s||'').toLowerCase();
    if (s.includes('crit')) return 'critical';
    if (s.includes('high')) return 'high';
    if (s.includes('mod')) return 'moderate';
    return 'stable';
  }
  function phaseClass(p) {
    p = Number(p||0);
    if (p >= 5) return 'critical';
    if (p >= 4) return 'critical';
    if (p >= 3) return 'high';
    if (p >= 2) return 'moderate';
    return 'stable';
  }
  function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function escapeAttr(s){ return escapeHtml(s).replace(/"/g,'&quot;'); }

  // -------- Fetch one query --------
  async function fetchOne(q) {
    updatePulse(q.key, 'updating');
    try {
      const res = await fetch('/api/atom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: q.prompt }],
          mode: 'quick',
          stream: false,
          context: 'You are a data extractor. Return ONLY the requested JSON with no prose, no markdown. Values must be current within the last 24 hours.'
        })
      });
      if (!res.ok) throw new Error('fetch failed ' + res.status);
      const j = await res.json();
      const text = j.choices?.[0]?.message?.content || '';
      const data = extractJson(text);
      if (data && INJECTORS[q.injector]) {
        INJECTORS[q.injector](data);
        LIVE.lastRefresh[q.key] = new Date();
      }
    } catch (e) {
      console.warn('LIVE fetch failed for', q.key, e);
    } finally {
      updatePulse(q.key, 'live');
    }
  }

  function updatePulse(key, state) {
    const pulse = document.querySelector('.live-pulse[data-live-pulse]');
    if (!pulse) return;
    if (state === 'updating') pulse.classList.add('updating');
    else pulse.classList.remove('updating');
    const last = LIVE.lastRefresh[key];
    if (last) pulse.querySelector('.pulse-label') && (pulse.querySelector('.pulse-label').textContent = 'LIVE · ' + last.toLocaleTimeString());
  }

  // -------- Start live loops --------
  LIVE.start = function() {
    LIVE.stop();
    QUERIES.forEach(q => {
      // Initial fetch (staggered so we don't hammer)
      setTimeout(() => fetchOne(q), Math.random() * 3000 + 500);
      // Recurring
      LIVE.intervals[q.key] = setInterval(() => {
        if (LIVE.autoOn) fetchOne(q);
      }, q.interval);
    });
    // Ensure live pulse indicator exists
    ensureLivePulse();
  };
  LIVE.stop = function() {
    Object.values(LIVE.intervals).forEach(clearInterval);
    LIVE.intervals = {};
  };
  LIVE.refreshNow = function() {
    QUERIES.forEach(q => fetchOne(q));
  };
  LIVE.toggle = function() {
    LIVE.autoOn = !LIVE.autoOn;
    if (LIVE.autoOn) LIVE.refreshNow();
  };

  function ensureLivePulse() {
    if (document.querySelector('.live-pulse[data-live-pulse]')) return;
    const target = document.querySelector('.topbar-right') || document.querySelector('.topbar') || document.querySelector('.header-right');
    if (!target) return;
    const el = document.createElement('div');
    el.className = 'live-pulse';
    el.setAttribute('data-live-pulse','');
    el.innerHTML = '<span class="pulse-label">LIVE FEED · ONLINE</span>';
    el.style.cursor = 'pointer';
    el.title = 'Click to refresh now';
    el.addEventListener('click', () => LIVE.refreshNow());
    target.appendChild(el);
  }

  // Auto-start when ATOM is ready
  window.addEventListener('atom:ready', () => {
    setTimeout(() => LIVE.start(), 2000);
  });
})();
