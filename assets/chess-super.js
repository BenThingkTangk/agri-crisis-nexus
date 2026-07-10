/* ================================================================
   CHESS-SUPER.JS — Nirmata vs. The Crisis
   Fully interactive strategic board game.

   You play as Nirmata (4 pillar pieces) vs. 8 agri-crisis threats.
   Click a piece, click a valid square, ATOM narrates the move.
   Turn-based: after your move, the crisis retaliates.

   Board: 8x8 grid.
   - Nirmata pillars start on rank 1 (bottom row):
       Secure(SI), Coordination(CO), RegenBio(RB), Clinical(CL)
       centered at files d,e,f,g.
   - Threats occupy rank 7 (top row), 8 pieces across files a-h:
       Famine, Hormuz, Palantir, Deere, Bayer, ExportBan, Drought, Locust
   - Neutral: rank 4 & 5 have "resource zones" (grain, water, biotech IP,
     clinical data) that give bonuses when captured.
   ================================================================ */
(function(){
  'use strict';

  const PILLARS = [
    { id:'SI', name:'Secure Infrastructure', short:'SEC', icon:'🛡️', hp: 10, atk: 3, moves: ['line'], file: 3 },
    { id:'CO', name:'Coordination Layer',    short:'COORD', icon:'🧭', hp: 8, atk: 2, moves: ['knight','diag'], file: 4 },
    { id:'RB', name:'Regenerative Biology',  short:'BIO', icon:'🧬', hp: 12, atk: 2, moves: ['line'], file: 5 },
    { id:'CL', name:'Clinical Intelligence', short:'CLIN', icon:'🩺', hp: 9, atk: 4, moves: ['diag','knight'], file: 6 }
  ];

  const THREATS = [
    { id:'FAM', name:'Famine Cascade',      icon:'☠️',  hp: 8, atk: 3, moves:['line'],   file: 0 },
    { id:'HRZ', name:'Hormuz Shock',         icon:'⚓', hp: 9, atk: 3, moves:['diag'],   file: 1 },
    { id:'PAL', name:'Palantir Lock-in',     icon:'🕸️', hp: 10, atk: 2, moves:['line'],  file: 2 },
    { id:'DEE', name:'Deere Platform',       icon:'🚜', hp: 8, atk: 2, moves:['knight'], file: 3 },
    { id:'BAY', name:'Bayer Digital-Bio',    icon:'💊', hp: 9, atk: 2, moves:['diag'],   file: 4 },
    { id:'EXP', name:'Export Bans',          icon:'🚫', hp: 7, atk: 4, moves:['line'],   file: 5 },
    { id:'DRT', name:'Drought Wave',         icon:'🏜️', hp: 10, atk: 2, moves:['knight'],file: 6 },
    { id:'LOC', name:'Locust Swarm',         icon:'🦗', hp: 6, atk: 3, moves:['diag'],   file: 7 }
  ];

  const RESOURCES = [
    { file:2, rank:3, id:'G', name:'Grain Reserve',   icon:'🌾', bonus:{atk:1} },
    { file:5, rank:3, id:'W', name:'Water Corridor',  icon:'💧', bonus:{atk:1} },
    { file:2, rank:4, id:'I', name:'Biotech IP',      icon:'🔬', bonus:{hp:3} },
    { file:5, rank:4, id:'D', name:'Clinical Data',   icon:'📊', bonus:{hp:3} }
  ];

  const state = {
    board: null,       // 8x8 array of pieces or nulls
    turn: 'nirmata',   // 'nirmata' | 'crisis'
    selected: null,    // {file, rank} of selected piece
    validMoves: [],    // [{file, rank, capture: bool}]
    log: [],           // move history
    over: false,
    winner: null,
    turnCount: 0
  };

  function makePiece(base, side){
    return { ...base, side, hp: base.hp, atkMod: 0, hpMod: 0 };
  }

  function initBoard(){
    const b = Array.from({length:8}, () => Array.from({length:8}, () => null));
    for (const p of PILLARS) b[0][p.file] = makePiece(p, 'nirmata');
    for (const t of THREATS) b[7][t.file] = makePiece(t, 'crisis');
    for (const r of RESOURCES) b[r.rank][r.file] = { ...r, side: 'resource' };
    state.board = b;
    state.turn = 'nirmata';
    state.selected = null;
    state.validMoves = [];
    state.log = [];
    state.over = false;
    state.winner = null;
    state.turnCount = 0;
  }

  function inBounds(f, r){ return f>=0 && f<8 && r>=0 && r<8; }

  function computeMoves(piece, from){
    const moves = [];
    const patterns = piece.moves;
    const rng = piece.side === 'nirmata' ? 1 : -1;

    if (patterns.includes('line')){
      // 4 orthogonal directions, distance 1-3
      for (const [df, dr] of [[1,0],[-1,0],[0,1],[0,-1]]){
        for (let d=1; d<=3; d++){
          const nf = from.file + df*d, nr = from.rank + dr*d;
          if (!inBounds(nf,nr)) break;
          const occ = state.board[nr][nf];
          if (occ){
            if (occ.side !== piece.side && occ.side !== piece.side) moves.push({file:nf,rank:nr,capture:true});
            break;
          }
          moves.push({file:nf,rank:nr,capture:false});
        }
      }
    }
    if (patterns.includes('diag')){
      for (const [df,dr] of [[1,1],[-1,1],[1,-1],[-1,-1]]){
        for (let d=1; d<=3; d++){
          const nf = from.file + df*d, nr = from.rank + dr*d;
          if (!inBounds(nf,nr)) break;
          const occ = state.board[nr][nf];
          if (occ){
            if (occ.side !== piece.side) moves.push({file:nf,rank:nr,capture:true});
            break;
          }
          moves.push({file:nf,rank:nr,capture:false});
        }
      }
    }
    if (patterns.includes('knight')){
      for (const [df,dr] of [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]]){
        const nf = from.file + df, nr = from.rank + dr;
        if (!inBounds(nf,nr)) continue;
        const occ = state.board[nr][nf];
        if (occ && occ.side === piece.side) continue;
        moves.push({file:nf,rank:nr,capture:!!occ});
      }
    }
    // Dedup
    const seen = new Set();
    return moves.filter(m => {
      const k = `${m.file},${m.rank}`;
      if (seen.has(k)) return false; seen.add(k); return true;
    });
  }

  function movePiece(from, to){
    const piece = state.board[from.rank][from.file];
    if (!piece) return;
    const target = state.board[to.rank][to.file];
    let narrative = `${piece.icon} ${piece.short || piece.id} moves ${sqName(from)} → ${sqName(to)}`;
    let capture = null;
    if (target){
      if (target.side === 'resource'){
        // Absorb bonus
        if (target.bonus.atk) piece.atkMod = (piece.atkMod||0) + target.bonus.atk;
        if (target.bonus.hp)  { piece.hpMod = (piece.hpMod||0) + target.bonus.hp; piece.hp += target.bonus.hp; }
        narrative += ` — captured ${target.name} (+${target.bonus.atk ? `${target.bonus.atk} ATK` : `${target.bonus.hp} HP`})`;
      } else {
        // Combat
        const attackerAtk = piece.atk + (piece.atkMod||0);
        const defenderAtk = target.atk + (target.atkMod||0);
        target.hp -= attackerAtk;
        piece.hp -= Math.floor(defenderAtk / 2);  // counter-damage
        narrative += ` — engages ${target.icon} ${target.name}: dealt ${attackerAtk}, took ${Math.floor(defenderAtk/2)}`;
        if (target.hp <= 0){
          narrative += ` — ${target.name} eliminated`;
          capture = target;
        } else {
          narrative += ` — ${target.name} HP ${target.hp}`;
          // Attacker doesn't take target's square if defender survives
          state.board[from.rank][from.file] = piece.hp > 0 ? piece : null;
          if (piece.hp <= 0){
            narrative += ` — ${piece.name} destroyed in the exchange`;
          }
          state.log.push(narrative);
          return;
        }
      }
    }
    state.board[to.rank][to.file] = piece;
    state.board[from.rank][from.file] = null;
    if (piece.hp <= 0){
      state.board[to.rank][to.file] = null;
      narrative += ` — ${piece.name} destroyed`;
    }
    state.log.push(narrative);
  }

  function sqName({file, rank}){
    return 'abcdefgh'[file] + (rank+1);
  }

  function endTurn(){
    state.turnCount++;
    // Check win
    const nirmataLeft = countSide('nirmata');
    const crisisLeft  = countSide('crisis');
    if (nirmataLeft === 0){ state.over = true; state.winner = 'crisis'; render(); return; }
    if (crisisLeft === 0){  state.over = true; state.winner = 'nirmata'; render(); return; }
    state.turn = state.turn === 'nirmata' ? 'crisis' : 'nirmata';
    if (state.turn === 'crisis') setTimeout(crisisAI, 900);
    render();
  }

  function countSide(side){
    let n = 0;
    for (const row of state.board) for (const cell of row) if (cell && cell.side === side) n++;
    return n;
  }

  function crisisAI(){
    if (state.over) return;
    // Find all crisis pieces, pick the one with best move (capture > advance)
    const candidates = [];
    for (let r=0; r<8; r++) for (let f=0; f<8; f++){
      const p = state.board[r][f];
      if (p && p.side === 'crisis'){
        const moves = computeMoves(p, {file:f, rank:r});
        for (const m of moves){
          let score = 0;
          if (m.capture){
            const tgt = state.board[m.rank][m.file];
            if (tgt && tgt.side === 'nirmata') score += 100 + tgt.hp;
            else if (tgt && tgt.side === 'resource') score += 30;
          }
          score -= m.rank * 2;  // prefer moving down toward Nirmata
          candidates.push({from:{file:f,rank:r}, to:m, score});
        }
      }
    }
    if (!candidates.length){ endTurn(); return; }
    candidates.sort((a,b) => b.score - a.score);
    const best = candidates[0];
    movePiece(best.from, best.to);
    endTurn();
  }

  // -------- RENDERING --------
  function render(){
    const host = document.getElementById('chess-host');
    if (!host) return;
    host.innerHTML = `
      <div class="chess-wrap">
        <div class="chess-board">${renderBoard()}</div>
        <div class="chess-side">${renderHUD()}</div>
      </div>
      <div class="chess-log" id="chess-log">${renderLog()}</div>
    `;
    wireBoard();
  }

  function renderBoard(){
    let html = '';
    // Rank labels + squares; render from rank 7 down to 0 for visual top-down
    for (let r = 7; r >= 0; r--){
      for (let f = 0; f < 8; f++){
        const light = (f + r) % 2 === 0;
        const piece = state.board[r][f];
        const isValid = state.validMoves.some(m => m.file === f && m.rank === r);
        const isSelected = state.selected && state.selected.file === f && state.selected.rank === r;
        const capture = state.validMoves.find(m => m.file === f && m.rank === r)?.capture;
        html += `<div class="chess-sq ${light?'light':'dark'} ${isValid?'valid':''} ${isSelected?'selected':''} ${capture?'capture':''}" data-file="${f}" data-rank="${r}">`;
        if (piece){
          html += `<div class="chess-piece ${piece.side}" title="${piece.name} · HP ${piece.hp || ''}">
            <span class="chess-icon">${piece.icon}</span>
            ${piece.hp !== undefined ? `<span class="chess-hp">${piece.hp}</span>` : ''}
          </div>`;
        }
        if (isValid && !piece){ html += `<div class="chess-dot"></div>`; }
        html += `</div>`;
      }
    }
    return html;
  }

  function renderHUD(){
    const nirmataPieces = [];
    const crisisPieces = [];
    for (let r=0; r<8; r++) for (let f=0; f<8; f++){
      const p = state.board[r][f];
      if (!p) continue;
      if (p.side === 'nirmata') nirmataPieces.push(p);
      else if (p.side === 'crisis') crisisPieces.push(p);
    }
    const winBanner = state.over
      ? `<div class="chess-banner ${state.winner === 'nirmata' ? 'win':'lose'}">
           ${state.winner === 'nirmata' ? '◆ Nirmata prevails' : '⚠ Crisis prevails'}
           <button class="chess-btn" id="chess-restart">Play Again</button>
         </div>`
      : '';
    const turnBanner = state.over ? '' : `
      <div class="chess-turn ${state.turn}">
        ${state.turn === 'nirmata' ? '◆ Your move' : '⚙ Crisis is planning…'}
      </div>`;
    return `
      ${winBanner}
      ${turnBanner}
      <div class="chess-roster">
        <div class="chess-roster-h">Nirmata Pillars</div>
        ${nirmataPieces.map(p => `
          <div class="chess-roster-item">
            <span class="chess-icon">${p.icon}</span>
            <div class="chess-roster-body">
              <div class="chess-roster-name">${p.name}</div>
              <div class="chess-roster-stats">HP ${p.hp} · ATK ${p.atk + (p.atkMod||0)}</div>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="chess-roster">
        <div class="chess-roster-h">Active Threats</div>
        ${crisisPieces.map(p => `
          <div class="chess-roster-item threat">
            <span class="chess-icon">${p.icon}</span>
            <div class="chess-roster-body">
              <div class="chess-roster-name">${p.name}</div>
              <div class="chess-roster-stats">HP ${p.hp} · ATK ${p.atk}</div>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="chess-actions">
        <button class="chess-btn" id="chess-restart-2">↻ New Game</button>
        <button class="chess-btn chess-btn-primary" id="chess-ask-atom">Ask ATOM for a strategy</button>
      </div>
    `;
  }

  function renderLog(){
    if (!state.log.length) return `<div class="chess-log-empty">Move a pillar to begin. Click a piece, then click a highlighted square.</div>`;
    return `
      <div class="chess-log-h">Move Log</div>
      <div class="chess-log-list">
        ${state.log.slice(-8).reverse().map((entry, i) => `
          <div class="chess-log-item">
            <span class="chess-log-turn">T${state.log.length - i}</span>
            <span>${entry}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function wireBoard(){
    document.querySelectorAll('.chess-sq').forEach(sq => {
      sq.addEventListener('click', () => onSquareClick(+sq.dataset.file, +sq.dataset.rank));
    });
    const restart = document.getElementById('chess-restart') || document.getElementById('chess-restart-2');
    if (restart) restart.addEventListener('click', () => { initBoard(); render(); });
    const restart2 = document.getElementById('chess-restart-2');
    if (restart2 && restart2 !== restart) restart2.addEventListener('click', () => { initBoard(); render(); });
    const ask = document.getElementById('chess-ask-atom');
    if (ask) ask.addEventListener('click', () => {
      const brief = buildStrategicBrief();
      if (window.ATOM && ATOM.ask) ATOM.ask(brief, { mode: 'reasoning' });
    });
  }

  function onSquareClick(file, rank){
    if (state.over || state.turn !== 'nirmata') return;
    const piece = state.board[rank][file];
    // If we have a selection, and this is a valid move, execute
    if (state.selected){
      const move = state.validMoves.find(m => m.file === file && m.rank === rank);
      if (move){
        movePiece(state.selected, {file, rank});
        state.selected = null;
        state.validMoves = [];
        endTurn();
        return;
      }
      // Otherwise: reselect if own piece
      if (piece && piece.side === 'nirmata'){
        state.selected = {file, rank};
        state.validMoves = computeMoves(piece, {file, rank});
      } else {
        state.selected = null;
        state.validMoves = [];
      }
      render();
      return;
    }
    // No selection: only allow selecting own piece
    if (piece && piece.side === 'nirmata'){
      state.selected = {file, rank};
      state.validMoves = computeMoves(piece, {file, rank});
      render();
    }
  }

  function buildStrategicBrief(){
    const nir = [];
    const cri = [];
    for (let r=0; r<8; r++) for (let f=0; f<8; f++){
      const p = state.board[r][f];
      if (!p || p.side === 'resource') continue;
      const item = `${p.name} at ${sqName({file:f,rank:r})} (HP ${p.hp})`;
      if (p.side === 'nirmata') nir.push(item); else cri.push(item);
    }
    return `We're playing Nirmata vs. the Crisis on the strategic board.
Nirmata pieces: ${nir.join('; ')}.
Active threats: ${cri.join('; ')}.
Last few moves: ${state.log.slice(-3).join(' | ') || '(none yet)'}.
Give me the sharpest next-move recommendation, why, and what to watch for from the crisis retaliation. Keep it tactical and specific.`;
  }

  function mount(){
    let host = document.getElementById('chess-host');
    if (!host){
      const mod = document.querySelector('.module[data-mod="chess"]');
      if (!mod) return false;
      // Inject a fresh host inside the module
      mod.innerHTML = `
        <div style="max-width: 1180px; margin: 0 auto;">
          <div id="chess-host"></div>
        </div>
      `;
      host = mod.querySelector('#chess-host');
    }
    initBoard();
    render();
    return true;
  }

  // Retry until the module exists
  function tryMount(attempt = 0){
    if (mount()) return;
    if (attempt < 30) setTimeout(() => tryMount(attempt+1), 400);
  }

  document.addEventListener('DOMContentLoaded', () => setTimeout(() => tryMount(0), 200));
  window.addEventListener('shell:ready', () => setTimeout(() => tryMount(0), 200));
})();
