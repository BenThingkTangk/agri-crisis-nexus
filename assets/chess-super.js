/* ==============================================================
   CHESS SUPERCHARGE — Live moves feed + ATOM strategist mode
   Enhances existing chess board without replacing it
   ============================================================== */
(function(){
  'use strict';

  function inject() {
    // Find chess pane
    const pane = document.querySelector('.module[data-mod="chess"]')
      || document.querySelector('[data-tab-pane="chess"]')
      || document.getElementById('pane-chess')
      || document.querySelector('.chess-board')?.closest('.tab-pane, .pane, .module');
    if (!pane) return setTimeout(inject, 1000);

    // Only inject once
    if (document.getElementById('chess-super-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'chess-super-panel';
    panel.className = 'panel';
    panel.style.cssText = 'margin-top:16px;background:linear-gradient(180deg,rgba(255,45,85,.03),transparent);border:1px solid rgba(255,45,85,.2);border-radius:12px;overflow:hidden';
    panel.innerHTML = `
      <div class="panel-header" style="display:flex;align-items:center;gap:10px;padding:12px 16px;background:rgba(255,45,85,.06);border-bottom:1px solid rgba(255,45,85,.15)">
        <div class="win-dots">
          <span style="background:#ff5f57"></span>
          <span style="background:#ffbd2e"></span>
          <span style="background:#28c840"></span>
        </div>
        <div style="font-family:'Clash Display',sans-serif;font-weight:600;font-size:13px;letter-spacing:.18em;color:#ff2d55">
          ◉ LIVE GEOPOLITICAL MOVES · PAST 72H
        </div>
        <div style="margin-left:auto;display:flex;gap:8px">
          <button class="chess-live-toggle active" id="chess-live-toggle">
            <span style="width:6px;height:6px;border-radius:50%;background:#00ffb3;box-shadow:0 0 8px #00ffb3"></span>
            LIVE
          </button>
          <button class="chess-live-toggle" id="chess-atom-strategist" style="border-color:rgba(0,229,255,.4);color:#00e5ff">
            ◉ ATOM STRATEGIST
          </button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px">
        <div>
          <div style="font-family:'Space Mono',monospace;font-size:10px;color:#7d8ba0;margin-bottom:8px;letter-spacing:.1em">◉ LIVE MOVES</div>
          <div id="chess-live-feed" style="max-height:280px;overflow-y:auto">
            <div style="padding:12px;color:#7d8ba0;font-family:'Rajdhani',sans-serif;font-size:12px;text-align:center">Awaiting live intel from Perplexity Sonar…</div>
          </div>
        </div>
        <div>
          <div style="font-family:'Space Mono',monospace;font-size:10px;color:#7d8ba0;margin-bottom:8px;letter-spacing:.1em">◉ ACTOR PROBE</div>
          <select id="chess-actor-select" style="width:100%;padding:8px;background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.1);border-radius:6px;color:#fff;font-family:'Rajdhani',sans-serif;font-size:12px;margin-bottom:8px">
            <option value="">— select actor for deep probe —</option>
          </select>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
            <button class="chess-live-toggle" data-probe="moves" style="border-color:rgba(255,45,85,.4);color:#ff2d55">NEXT MOVES</button>
            <button class="chess-live-toggle" data-probe="weak" style="border-color:rgba(245,200,66,.4);color:#f5c842">WEAK POINTS</button>
            <button class="chess-live-toggle" data-probe="lever" style="border-color:rgba(0,229,255,.4);color:#00e5ff">OUR LEVERS</button>
            <button class="chess-live-toggle" data-probe="counter" style="border-color:rgba(191,95,255,.4);color:#bf5fff">COUNTER-PLAYS</button>
          </div>
          <div id="actor-probe-result" style="margin-top:12px;padding:10px;background:rgba(0,0,0,.3);border-radius:8px;font-family:'Satoshi',sans-serif;font-size:11px;color:#a8b4c8;min-height:60px;line-height:1.5">
            Pick an actor and a probe type to interrogate their playbook via ATOM.
          </div>
        </div>
      </div>
      <div style="padding:0 16px 16px">
        <div style="font-family:'Space Mono',monospace;font-size:10px;color:#7d8ba0;margin-bottom:8px;letter-spacing:.1em">◉ AI-GENERATED CHESS SCENARIOS</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="chess-live-toggle" data-cscen="ru-wheat">RU cuts Ukraine wheat pipeline</button>
          <button class="chess-live-toggle" data-cscen="cn-embargo">CN embargoes AU wheat</button>
          <button class="chess-live-toggle" data-cscen="in-rice">IN full rice export halt</button>
          <button class="chess-live-toggle" data-cscen="us-fert">US fertilizer weaponized</button>
          <button class="chess-live-toggle" data-cscen="tr-corridor">TR closes Bosphorus grain traffic</button>
          <button class="chess-live-toggle" data-cscen="opec-food">OPEC-style food cartel forms</button>
        </div>
      </div>
    `;
    pane.appendChild(panel);

    // Populate actor select from CHESS_ACTORS
    const sel = document.getElementById('chess-actor-select');
    if (window.CHESS_ACTORS && sel) {
      window.CHESS_ACTORS.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.name || a.actor || a.country || '';
        opt.textContent = `${a.name || a.actor || a.country} ${a.role ? '· ' + a.role : ''}`;
        sel.appendChild(opt);
      });
    }

    // Wire live toggle
    document.getElementById('chess-live-toggle').onclick = () => {
      window.LIVE?.toggle();
      document.getElementById('chess-live-toggle').classList.toggle('active');
    };
    document.getElementById('chess-atom-strategist').onclick = () => {
      window.ATOM?.ask(
        'You are now the Chief Strategist. Based on the current chess board, tell me: (1) the single highest-EV move each major state actor will play in the next 30 days, (2) the top three moves Nirmata Holdings should make to position across these vectors, (3) the two black-swan risks not on our board yet. Cite sources.',
        { mode: 'reasoning' }
      );
    };

    // Actor probe buttons
    panel.querySelectorAll('[data-probe]').forEach(btn => {
      btn.onclick = async () => {
        const actor = sel.value;
        if (!actor) { flash(document.getElementById('actor-probe-result'), 'Select an actor first.'); return; }
        const probe = btn.dataset.probe;
        const prompts = {
          moves: `What are the 3 highest-probability moves ${actor} will make in the global food/agriculture chessboard over the next 60 days? For each: move description, probability %, trigger conditions, market impact. Cite sources.`,
          weak: `What are the 3 most exploitable weak points of ${actor} in the current food/agriculture geopolitical landscape? For each: weakness, why it matters, who could exploit it. Cite sources.`,
          lever: `What are the specific levers Nirmata Holdings (AntimatterAI post-quantum, ThingkTangk HumanOS, RRG.bio regen biotech, TryClinixAI clinical) could pull vis-à-vis ${actor} in the current food-war landscape? Give 3 concrete plays. Cite sources.`,
          counter: `List 3 concrete counter-plays that other actors (state or corporate) would deploy against ${actor}'s recent moves in agriculture/food/commodities. Include cost, timeline, probability of success. Cite sources.`
        };
        const box = document.getElementById('actor-probe-result');
        box.innerHTML = '<span class="atom-typing"><span></span><span></span><span></span></span> Probing…';
        const result = await window.ATOM?.silentQuery(prompts[probe], 'reasoning');
        if (result && result.text) {
          const clean = result.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
          box.innerHTML = renderMd(clean) + (result.citations?.length
            ? `<div style="margin-top:8px;padding-top:6px;border-top:1px dashed rgba(255,255,255,.08);font-family:'Space Mono',monospace;font-size:9px;color:#7d8ba0">${result.citations.slice(0,4).map((c,i)=>`<a href="${c}" target="_blank" style="color:#00e5ff;margin-right:8px">[${i+1}]</a>`).join('')}</div>`
            : '');
        } else {
          box.textContent = 'Signal degraded. Retry.';
        }
      };
    });

    // Chess scenarios
    panel.querySelectorAll('[data-cscen]').forEach(btn => {
      btn.onclick = () => {
        const s = btn.dataset.cscen;
        const map = {
          'ru-wheat': 'Russia cuts all Ukraine wheat pipeline access',
          'cn-embargo': 'China embargoes Australian wheat imports fully',
          'in-rice': 'India halts all rice exports for 12 months',
          'us-fert': 'US weaponizes fertilizer/phosphate exports vs. adversaries',
          'tr-corridor': 'Turkey closes Bosphorus to grain traffic',
          'opec-food': 'A food-exporter cartel (BR-AR-RU-UA-KZ) forms on OPEC model'
        };
        window.ATOM?.ask(
          `Chess scenario: "${map[s]}". Play out the next 6 moves in this game — who moves next, what tools they use, cascade effects, and where Nirmata Holdings positions to profit / mitigate. Emit an atom-artifact with type "scenario".`,
          { mode: 'reasoning' }
        );
      };
    });
  }

  function renderMd(text) {
    return text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.+?)\*\*/g,'<strong style="color:#00e5ff">$1</strong>')
      .replace(/\*(.+?)\*/g,'<em style="color:#f5c842">$1</em>')
      .replace(/\[(\d+)\]/g,'<sup style="color:#00e5ff">[$1]</sup>')
      .replace(/^-\s+(.+)$/gm,'<div style="margin:3px 0;padding-left:12px;border-left:2px solid rgba(0,229,255,.3)">$1</div>')
      .replace(/\n\n/g,'<br><br>').replace(/\n/g,'<br>');
  }

  function flash(el, msg) {
    if (!el) return;
    const prev = el.innerHTML;
    el.innerHTML = `<span style="color:#f5c842">${msg}</span>`;
    setTimeout(()=>el.innerHTML = prev, 2000);
  }

  window.addEventListener('atom:ready', () => setTimeout(inject, 800));
})();
