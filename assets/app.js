/* ============================================================
   AGRI-NEXUS COMMAND CENTER — application controller
   Deterministic: modes render on first activation, single scroll.
   ============================================================ */
(function(){
'use strict';
const D = window.AGRI;
const PASSWORD = "PutinSucksTinyChinaCocks"; // JS variable only — never persisted
const $ = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>Array.from(r.querySelectorAll(s));
const el = (tag,cls,html)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e;};
const esc = s => String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sevLabel = {critical:'Critical',high:'Elevated',moderate:'Watch',stable:'Stable',neutral:'Neutral'};
const badge = tl => `<span class="badge ${tl}"><span class="d"></span>${sevLabel[tl]||tl}</span>`;
const icon = (name,cls='ic') => `<i data-lucide="${name}" class="${cls}"></i>`;
function refreshIcons(){ if(window.lucide) try{ lucide.createIcons(); }catch(e){} }

/* ---------------- MODES ---------------- */
const MODES = [
  {id:'command', label:'Command', icon:'layout-dashboard'},
  {id:'map', label:'Map', icon:'globe'},
  {id:'intel', label:'Intel', icon:'newspaper'},
  {id:'strategy', label:'Strategy', icon:'target'},
  {id:'simulate', label:'War Room', icon:'swords'},
  {id:'resources', label:'Data', icon:'database'},
  {id:'atom', label:'ATOM', icon:'sparkles'},
];
const rendered = {};

/* ================= PASSWORD GATE ================= */
function initGate(){
  const form=$('#gateForm'), input=$('#gateInput'), err=$('#gateErr');
  form.addEventListener('submit',e=>{
    e.preventDefault();
    if(input.value===PASSWORD){
      $('#gate').style.display='none';
      $('#app').style.display='flex';
      boot();
    } else {
      err.textContent='ACCESS DENIED — credential rejected.';
      input.value=''; input.focus();
      form.animate([{transform:'translateX(-6px)'},{transform:'translateX(6px)'},{transform:'none'}],{duration:220});
    }
  });
}

/* ================= BOOT ================= */
function boot(){
  buildNav();
  startClock();
  bindShell();
  buildAtom();
  activateMode('command');
  refreshIcons();
}

function buildNav(){
  const nav=$('#modes');
  MODES.forEach(m=>{
    const b=el('button','mode-tab',`${icon(m.icon)}<span>${m.label}</span>`);
    b.dataset.mode=m.id;
    b.setAttribute('aria-label',m.label+' mode');
    b.addEventListener('click',()=>{activateMode(m.id); closeMobileNav();});
    nav.appendChild(b);
  });
}

function activateMode(id){
  $$('.mode-tab').forEach(t=>t.classList.toggle('active',t.dataset.mode===id));
  $$('.mode-panel').forEach(p=>p.classList.toggle('active',p.dataset.mode===id));
  if(!rendered[id]){ renderMode(id); rendered[id]=true; }
  $('#workspace').scrollTop=0;
  refreshIcons();
  // lazy init heavy modules
  if(id==='map') setTimeout(initMap,60);
  if(id==='resources') setTimeout(()=>drawResourceCharts(currentResTab),60);
  if(id==='strategy') setTimeout(drawStrategyChart,60);
}

function renderMode(id){
  const p=$('#panel-'+id);
  ({command:renderCommand,map:renderMap,intel:renderIntel,strategy:renderStrategy,
    simulate:renderSimulate,resources:renderResources,atom:renderAtomMode}[id])(p);
  refreshIcons();
}

/* ================= CLOCK ================= */
function startClock(){
  const t=$('#clockTime');
  const tick=()=>{ const d=new Date(); t.textContent=d.toISOString().slice(0,10)+' '+d.toUTCString().slice(17,25)+'Z'; };
  tick(); setInterval(tick,1000);
}

/* ================= SHELL BINDINGS ================= */
function bindShell(){
  $('#openAtom').addEventListener('click',()=>openAtom());
  $('#atomClose').addEventListener('click',closeAtom);
  $('#drawerClose').addEventListener('click',closeDrawer);
  $('#drawerScrim').addEventListener('click',closeDrawer);
  const ham=$('#hamburger');
  ham.addEventListener('click',()=>{
    const open=$('#modes').classList.toggle('open');
    $('#navScrim').classList.toggle('open',open);
    ham.setAttribute('aria-expanded',open?'true':'false');
  });
  $('#navScrim').addEventListener('click',closeMobileNav);
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      if($('#atom').classList.contains('open')) closeAtom();
      else if($('#drawer').classList.contains('open')) closeDrawer();
      else closeMobileNav();
    }
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){ e.preventDefault(); openAtom(); }
  });
}
function closeMobileNav(){ $('#modes').classList.remove('open'); $('#navScrim').classList.remove('open'); $('#hamburger').setAttribute('aria-expanded','false'); }

/* ================= DRAWER ================= */
function openDrawer(title,bodyHTML){
  $('#drawerTitle').innerHTML=title;
  $('#drawerBody').innerHTML=bodyHTML;
  $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden','false');
  $('#drawerScrim').classList.add('open');
  refreshIcons();
}
function closeDrawer(){ $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden','true'); $('#drawerScrim').classList.remove('open'); }

/* ================= COMMAND ================= */
function renderCommand(p){
  const critical = D.COUNTRIES.filter(c=>c.tl==='critical');
  const watch = [...D.COUNTRIES].sort((a,b)=>(b.conflict+b.climate+b.hungerPct)-(a.conflict+a.climate+a.hungerPct)).slice(0,7);
  p.innerHTML = `
    <div class="mode-head">
      <div class="eyebrow">Global Threat Dashboard · as of ${D.AS_OF}</div>
      <h2>The world is entering a <em>food-security polycrisis</em></h2>
      <p class="lede">Climate extremes, weaponized grain, fertilizer shocks and aquifer depletion are converging. This overview orients decision-makers before drilling into the map, intel feed, and strategic response.</p>
    </div>

    <div class="kpi-strip" id="cmdKpis"></div>

    <div class="section">
      <div class="section-title"><h3>${icon('activity')} Crisis vectors</h3><span class="meta">Composite severity · 0–100</span></div>
      <div class="two-col">
        <div class="panel" id="cmdVectors"></div>
        <div class="panel">
          <div class="panel-h"><h4>${icon('siren')} Active watchlist</h4><span class="chip">${critical.length} critical</span></div>
          <div class="rows" id="cmdWatch"></div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title"><h3>${icon('gauge')} Societal readiness &amp; policy signals</h3></div>
      <div class="two-col">
        <div class="panel" id="cmdReadiness"></div>
        <div class="panel">
          <div class="panel-h"><h4>${icon('landmark')} Policy signals</h4></div>
          <div class="rows" id="cmdPolicy"></div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title"><h3>${icon('milestone')} Strategic timeline</h3><span class="meta">scroll horizontally →</span></div>
      <div class="panel pad0"><div class="tl xscroll" id="cmdTimeline" style="padding:16px"></div></div>
    </div>

    <div class="section">
      <div class="section-title"><h3>${icon('zap')} Quick actions</h3></div>
      <div class="cards" id="cmdActions" style="grid-template-columns:repeat(auto-fill,minmax(230px,1fr))"></div>
    </div>`;

  // KPIs
  $('#cmdKpis').innerHTML = D.KPIS.map(k=>`
    <div class="kpi c-${k.sev}">
      <div class="val">${esc(k.val)}</div>
      <div class="lbl">${esc(k.lbl)}</div>
      <div class="delta ${k.dir}">${k.dir==='up'?'▲':k.dir==='down'?'▼':'—'} ${esc(k.delta)}</div>
      <div class="src">${esc(k.src)}</div>
    </div>`).join('');

  // vectors
  const sevColor={critical:'var(--sev-critical)',high:'var(--sev-high)',moderate:'var(--sev-moderate)',stable:'var(--sev-stable)'};
  $('#cmdVectors').innerHTML = `<div class="panel-h"><h4>${icon('bar-chart-3')} Convergence pressure</h4></div>`+
    D.VECTORS.map(v=>`
    <div class="vec">
      <div class="vh"><span>${esc(v.name)}</span><span class="vv">${v.v} · ${esc(v.src)}</span></div>
      <div class="track"><div class="fill" style="width:${v.v}%;background:${sevColor[v.sev]}"></div></div>
    </div>`).join('');

  // watchlist
  $('#cmdWatch').innerHTML = watch.map(c=>`
    <div class="row-item" role="button" tabindex="0" data-code="${c.code}">
      <div class="flag">${c.flag}</div>
      <div class="ri-main"><div class="t">${esc(c.name)}</div><div class="s">IPC ${c.ipc} · ${c.hungerPct}% food-insecure · ${esc(c.cont)}</div></div>
      <div class="ri-end">${badge(c.tl)}</div>
    </div>`).join('');
  $$('#cmdWatch .row-item').forEach(r=>{
    const open=()=>{ activateMode('map'); setTimeout(()=>showCountry(r.dataset.code),120); };
    r.addEventListener('click',open);
    r.addEventListener('keydown',e=>{if(e.key==='Enter')open();});
  });

  // readiness
  $('#cmdReadiness').innerHTML = `<div class="panel-h"><h4>${icon('users')} Readiness indicators</h4></div>`+
    D.READINESS.map(r=>{
      const disp = r.unit ? `${r.v}${r.unit==='%'?'%':' '+r.unit}` : r.v+'%';
      const w = r.unit&&r.unit!=='%' ? Math.min(100,100) : Math.min(100,r.v);
      return `<div class="vec">
        <div class="vh"><span>${esc(r.k)}</span><span class="vv">${esc(disp)}</span></div>
        <div class="track"><div class="fill" style="width:${w}%;background:${sevColor[r.sev]}"></div></div>
        <div class="s muted" style="font-size:11.5px;margin-top:5px">${esc(r.note)} · <span class="mono">${esc(r.src)}</span></div>
      </div>`;
    }).join('');

  // policy
  const toneBadge={positive:'stable',watch:'high',negative:'critical'};
  $('#cmdPolicy').innerHTML = D.POLICY_SIGNALS.map(s=>`
    <div class="row-item">
      <div class="ri-main"><div class="t" style="white-space:normal">${esc(s.t)}</div><div class="s">${esc(s.src)} · ${esc(s.date)}</div></div>
      <div class="ri-end">${badge(toneBadge[s.tone])}</div>
    </div>`).join('');

  // timeline
  $('#cmdTimeline').innerHTML = D.TIMELINE_EVENTS.map(t=>`
    <div class="node ${t.cat}"><div class="dot"></div><div class="yr">${t.year}</div><div class="ti">${esc(t.title)}</div></div>`).join('');

  // actions
  $('#cmdActions').innerHTML = D.QUICK_ACTIONS.map((a,i)=>`
    <button class="card" data-i="${i}" style="cursor:pointer;text-align:left">
      <div class="ch">${icon(a.icon,'ic')}${icon('arrow-up-right','ic')}</div>
      <h4>${esc(a.t)}</h4>
    </button>`).join('');
  $$('#cmdActions .card').forEach(c=>{
    c.addEventListener('click',()=>{
      const a=D.QUICK_ACTIONS[+c.dataset.i];
      if(a.act==='atom') return openAtom();
      if(a.act==='print') return printBrief();
      if(a.mode) activateMode(a.mode);
      if(a.act==='brief') setTimeout(()=>{const b=$('#briefAnchor'); if(b) b.scrollIntoView({behavior:'smooth'});},200);
      if(a.act==='matrix') setTimeout(()=>{const b=$('#matrixAnchor'); if(b) b.scrollIntoView({behavior:'smooth'});},200);
    });
  });
}

/* ================= MAP ================= */
let mapObj=null, mapLayerGroup=null, activeLayer='food', wheelOn=false;
const LAYERS=[
  {id:'food',label:'Food security',metric:c=>c.hungerPct,color:c=>c.tl},
  {id:'conflict',label:'Conflict',metric:c=>c.conflict,color:c=>c.conflict>80?'critical':c.conflict>60?'high':c.conflict>40?'moderate':'stable'},
  {id:'climate',label:'Climate',metric:c=>c.climate,color:c=>c.climate>80?'critical':c.climate>65?'high':c.climate>50?'moderate':'stable'},
  {id:'water',label:'Water stress',metric:c=>c.water,color:c=>c.water>80?'critical':c.water>60?'high':c.water>40?'moderate':'stable'},
  {id:'supply',label:'Supply / production',metric:c=>c.production,color:c=>c.production<35?'critical':c.production<55?'high':c.production<75?'moderate':'stable'},
];
function renderMap(p){
  p.innerHTML=`
    <div class="mode-head">
      <div class="eyebrow">Interactive World Intelligence Map</div>
      <h2>Global crisis <em>geography</em></h2>
      <p class="lede">${D.COUNTRIES.length} monitored countries and ${D.AQUIFERS.length} stressed aquifers. Toggle layers to re-weight the map. Mouse-wheel zoom is off by default so the page scrolls freely — enable it with the control below.</p>
    </div>
    <div class="map-layers" id="mapLayers"></div>
    <div class="btn-row" style="margin-bottom:12px">
      <button class="btn sm" id="wheelToggle">${icon('mouse-pointer-2')} Wheel-zoom: OFF</button>
      <span class="chip">Click any marker for a country profile + sources</span>
    </div>
    <div class="panel pad0" style="border-radius:var(--radius)"><div id="map" role="application" aria-label="World crisis map"></div></div>
    <div class="section">
      <div class="section-title"><h3>${icon('droplets')} Aquifer stress overlay</h3><span class="meta">NASA GRACE · depletion %</span></div>
      <div class="cards" id="mapAquifers"></div>
    </div>`;
  $('#mapLayers').innerHTML = LAYERS.map(l=>`<button class="layer-btn ${l.id==='food'?'active':''}" data-layer="${l.id}"><span class="d"></span>${l.label}</button>`).join('');
  $$('#mapLayers .layer-btn').forEach(b=>b.addEventListener('click',()=>{activeLayer=b.dataset.layer;$$('#mapLayers .layer-btn').forEach(x=>x.classList.toggle('active',x===b));drawMarkers();}));
  $('#wheelToggle').addEventListener('click',()=>{
    wheelOn=!wheelOn;
    if(mapObj){ wheelOn?mapObj.scrollWheelZoom.enable():mapObj.scrollWheelZoom.disable(); }
    $('#wheelToggle').innerHTML=`${icon('mouse-pointer-2')} Wheel-zoom: ${wheelOn?'ON':'OFF'}`; refreshIcons();
  });
  $('#mapAquifers').innerHTML = D.AQUIFERS.map(a=>`
    <div class="card">
      <div class="ch"><div class="src-line">${icon('droplet','ic')} ${esc(a.region)}</div>${badge(a.tl)}</div>
      <h4>${esc(a.name)}</h4>
      <div class="track"><div class="fill" style="width:${a.depletion}%;background:var(--sev-${a.tl})"></div></div>
      <p style="font-size:12px">${esc(a.desc)}</p>
      <div class="cf"><span class="chip">${a.depletion}% depleted</span><span class="chip">~${a.years} yr to critical</span></div>
    </div>`).join('');
}
function initMap(){
  if(mapObj || !window.L || !$('#map')) return;
  mapObj = L.map('map',{scrollWheelZoom:false,worldCopyJump:true,minZoom:2,maxZoom:6,attributionControl:true}).setView([22,20],2);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{
    attribution:'&copy; OpenStreetMap &copy; CARTO', subdomains:'abcd', maxZoom:8
  }).addTo(mapObj);
  mapLayerGroup=L.layerGroup().addTo(mapObj);
  drawMarkers();
  setTimeout(()=>mapObj.invalidateSize(),120);
}
function drawMarkers(){
  if(!mapObj) return;
  mapLayerGroup.clearLayers();
  const layer=LAYERS.find(l=>l.id===activeLayer);
  const cc={critical:'#e2483d',high:'#e8913c',moderate:'#d9b23a',stable:'#5ba86f'};
  D.COUNTRIES.forEach(c=>{
    const val=layer.metric(c), tl=layer.color(c);
    const r=6+Math.round(val/8);
    const m=L.circleMarker([c.lat,c.lng],{radius:r,color:'#0a0c0f',weight:1.5,fillColor:cc[tl]||'#7d8794',fillOpacity:.82});
    m.bindPopup(`<b>${c.flag} ${esc(c.name)}</b><br><span style="font-family:var(--mono);font-size:11px;color:var(--muted)">${layer.label}: ${val} · IPC ${c.ipc}</span><br><a href="#" data-code="${c.code}" class="popupLink">Open profile →</a>`);
    m.on('popupopen',(ev)=>{const lk=ev.popup.getElement().querySelector('.popupLink'); if(lk) lk.addEventListener('click',e=>{e.preventDefault();showCountry(c.code);});});
    // accessible name via title on path
    m.on('add',()=>{ const p=m.getElement(); if(p){p.setAttribute('role','button');p.setAttribute('aria-label',c.name+' — '+layer.label+' '+val);p.setAttribute('tabindex','0'); p.addEventListener('keydown',e=>{if(e.key==='Enter')showCountry(c.code);});}});
    mapLayerGroup.addLayer(m);
  });
}
function showCountry(code){
  const c=D.COUNTRIES.find(x=>x.code===code); if(!c) return;
  const metrics=[['IPC phase','IPC '+c.ipc+' / 5'],['Food-insecure population',c.hungerPct+'%'],['Climate stress',c.climate+'/100'],['Conflict intensity',c.conflict+'/100'],['Production capacity',c.production+'/100'],['Water stress',c.water+'/100'],['Continent',c.cont],['Last event',c.lastEvent]];
  const related=D.INTEL_CARDS.filter(x=>x.region===c.name||x.region===c.cont).slice(0,3);
  openDrawer(`${c.flag} ${esc(c.name)} &nbsp; ${badge(c.tl)}`,`
    <div class="mlist">${metrics.map(m=>`<div class="mrow"><span class="k">${esc(m[0])}</span><span class="v">${esc(m[1])}</span></div>`).join('')}</div>
    <h4 style="font-size:13px;color:var(--muted);margin:16px 0 10px;font-family:var(--mono);letter-spacing:.06em;text-transform:uppercase">Related intelligence</h4>
    ${related.length?related.map(r=>`<div class="card" style="margin-bottom:10px"><div class="src-line">${icon('rss','ic')} ${esc(r.src)} · ${esc(r.date)} ${badge(r.tl)}</div><h4>${esc(r.head)}</h4><p style="font-size:12.5px">${esc(r.body)}</p></div>`).join(''):'<p class="muted">No linked feed items.</p>'}
    <div class="btn-row" style="margin-top:14px">
      <button class="btn primary" id="drawerAtom">${icon('sparkles')} Ask ATOM about ${esc(c.name)}</button>
    </div>
    <p class="muted" style="font-size:11px;margin-top:14px;font-family:var(--mono)">Methodology: composite indices blend FAO IPC, ACLED conflict density, NOAA climate anomaly, and NASA GRACE water stress. Directional, not forecast.</p>`);
  const ab=$('#drawerAtom'); if(ab) ab.addEventListener('click',()=>{closeDrawer();openAtom('Give me a strategic brief on the agricultural crisis in '+c.name+', with confidence and 3 sources.');});
}

/* ================= INTEL ================= */
let intelState={q:'',src:'all',cat:'all',sev:'all',signal:false};
function renderIntel(p){
  p.innerHTML=`
    <div class="mode-head">
      <div class="eyebrow">Intelligence Briefing Center · Live Feed</div>
      <h2>Signal from the <em>noise</em></h2>
      <p class="lede">${D.INTEL_CARDS.length} curated items from ${D.SOURCES.length} primary sources. Filter, search, or switch to signal-only mode. Every item carries source, freshness and a confidence score.</p>
    </div>

    <div class="panel" id="briefAnchor" style="margin-bottom:20px">
      <div class="panel-h"><h4>${icon('file-text')} 3-Minute Daily Brief — ${D.AS_OF}</h4>
        <div class="btn-row"><button class="btn sm" id="printBrief">${icon('printer')} Print</button></div>
      </div>
      <div id="briefBody"></div>
    </div>

    <div class="intel-controls">
      <label class="search">${icon('search')}<input id="intelSearch" type="text" placeholder="Search headlines, regions, bodies…" aria-label="Search intelligence"/></label>
      <select class="select" id="fSrc" aria-label="Source"><option value="all">All sources</option>${D.SOURCES.map(s=>`<option>${s}</option>`).join('')}</select>
      <select class="select" id="fCat" aria-label="Category"><option value="all">All categories</option>${D.CATS.map(c=>`<option>${c}</option>`).join('')}</select>
      <select class="select" id="fSev" aria-label="Severity"><option value="all">All severity</option><option value="critical">Critical</option><option value="high">Elevated</option><option value="moderate">Watch</option></select>
      <label class="toggle"><input type="checkbox" id="fSignal"/> Signal only (critical + elevated)</label>
    </div>
    <div class="section-title"><h3 id="intelCount">${icon('rss')} Feed</h3><button class="btn sm" id="exportIntel">${icon('download')} CSV</button></div>
    <div class="feed" id="intelFeed"></div>`;

  // brief
  const crit=D.INTEL_CARDS.filter(c=>c.tl==='critical').slice(0,5);
  const markets=D.INTEL_CARDS.filter(c=>c.cat==='MARKET SIGNAL').slice(0,3);
  $('#briefBody').innerHTML=`
    <p style="color:var(--text-dim);margin:0 0 12px">Five countries now sit in confirmed famine (IPC-5). The FAO Food Price Index has risen to 148.2 (+4.7% MoM) as wheat stocks-to-use hits an 8-year low. Fertilizer is up 35% since the Hormuz incident, delaying Q3 planting across MENA and South Asia.</p>
    <div class="two-col">
      <div><h4 style="font-size:12px;color:var(--sev-critical);font-family:var(--mono);letter-spacing:.06em;margin-bottom:8px">TOP FAMINE / CONFLICT</h4>
        <ul style="margin:0;padding-left:18px;color:var(--text-dim);font-size:13px;line-height:1.8">${crit.map(c=>`<li>${esc(c.head)} <span class="mono muted">(${esc(c.src)})</span></li>`).join('')}</ul></div>
      <div><h4 style="font-size:12px;color:var(--sev-high);font-family:var(--mono);letter-spacing:.06em;margin-bottom:8px">MARKET SIGNALS</h4>
        <ul style="margin:0;padding-left:18px;color:var(--text-dim);font-size:13px;line-height:1.8">${markets.map(c=>`<li>${esc(c.head)} <span class="mono muted">(${esc(c.src)})</span></li>`).join('')}</ul></div>
    </div>`;
  $('#printBrief').addEventListener('click',printBrief);

  // controls
  $('#intelSearch').addEventListener('input',e=>{intelState.q=e.target.value.toLowerCase();drawIntel();});
  $('#fSrc').addEventListener('change',e=>{intelState.src=e.target.value;drawIntel();});
  $('#fCat').addEventListener('change',e=>{intelState.cat=e.target.value;drawIntel();});
  $('#fSev').addEventListener('change',e=>{intelState.sev=e.target.value;drawIntel();});
  $('#fSignal').addEventListener('change',e=>{intelState.signal=e.target.checked;drawIntel();});
  $('#exportIntel').addEventListener('click',exportIntelCSV);
  drawIntel();
}
function filteredIntel(){
  return D.INTEL_CARDS.filter(c=>{
    if(intelState.src!=='all'&&c.src!==intelState.src)return false;
    if(intelState.cat!=='all'&&c.cat!==intelState.cat)return false;
    if(intelState.sev!=='all'&&c.tl!==intelState.sev)return false;
    if(intelState.signal&&!(c.tl==='critical'||c.tl==='high'))return false;
    if(intelState.q){const h=(c.head+c.body+c.region+c.src+c.cat).toLowerCase();if(!h.includes(intelState.q))return false;}
    return true;
  });
}
function drawIntel(){
  const items=filteredIntel();
  $('#intelCount').innerHTML=`${icon('rss')} Feed <span class="mono muted" style="font-size:12px">· ${items.length} items</span>`;
  const feed=$('#intelFeed');
  if(!items.length){ feed.innerHTML=`<div class="errbox" style="grid-column:1/-1"><div class="et">${icon('search-x')} No matching intelligence</div><button class="btn" id="intelReset">Reset filters</button></div>`; $('#intelReset').addEventListener('click',()=>{intelState={q:'',src:'all',cat:'all',sev:'all',signal:false};$('#intelSearch').value='';$('#fSrc').value='all';$('#fCat').value='all';$('#fSev').value='all';$('#fSignal').checked=false;drawIntel();}); refreshIcons(); return; }
  feed.innerHTML=items.map((c,i)=>`
    <article class="intel-card" data-i="${i}" tabindex="0">
      <div class="ic-top"><span class="chip">${esc(c.cat)}</span>${badge(c.tl)}</div>
      <h4>${esc(c.head)}</h4>
      <div class="body">${esc(c.body)}</div>
      <div class="ic-foot">${icon('circle-dot','ic')} ${esc(c.src)} <span>·</span> ${esc(c.region)} <span>·</span> ${esc(c.date)} <span>·</span> conf ${c.conf}%${c.pop!=='—'?` <span>·</span> ${esc(c.pop)}`:''}</div>
    </article>`).join('');
  $$('#intelFeed .intel-card').forEach(card=>{
    const open=()=>{const c=items[+card.dataset.i];openDrawer(`${esc(c.cat)}`,`
      <div class="ic-top" style="display:flex;gap:8px;margin-bottom:12px">${badge(c.tl)}<span class="chip">${esc(c.region)}</span></div>
      <h3 style="margin-bottom:12px">${esc(c.head)}</h3>
      <p style="color:var(--text-dim)">${esc(c.body)}</p>
      <div class="mlist"><div class="mrow"><span class="k">Source</span><span class="v">${esc(c.src)}</span></div><div class="mrow"><span class="k">Published</span><span class="v">${esc(c.date)}</span></div><div class="mrow"><span class="k">Confidence</span><span class="v">${c.conf}%</span></div><div class="mrow"><span class="k">Affected</span><span class="v">${esc(c.pop)}</span></div></div>
      <button class="btn primary" id="intelAtom" style="margin-top:8px">${icon('sparkles')} Ask ATOM to analyze</button>`);
      const a=$('#intelAtom'); if(a)a.addEventListener('click',()=>{closeDrawer();openAtom('Analyze this development and its strategic implications for Nirmata: '+c.head);});};
    card.addEventListener('click',open);
    card.addEventListener('keydown',e=>{if(e.key==='Enter')open();});
  });
  refreshIcons();
}

/* ================= STRATEGY ================= */
let strategyChart=null, currentFrame='questions';
function renderStrategy(p){
  p.innerHTML=`
    <div class="mode-head">
      <div class="eyebrow">Strategic War-Room · Advisor &amp; Scenarios</div>
      <h2>From crisis to <em>coherent response</em></h2>
      <p class="lede">A six-frame strategic advisor pre-populated with analysis, the Nirmata four-pillar architecture, an opportunity matrix, and a scenarios lab. ATOM can regenerate any frame live.</p>
    </div>

    <div class="section">
      <div class="section-title"><h3>${icon('brain')} Six-frame advisor</h3><button class="btn sm" id="frameAtom">${icon('sparkles')} Regenerate with ATOM</button></div>
      <div class="frame-tabs" id="frameTabs"></div>
      <div class="panel" id="frameBody" style="min-height:220px"></div>
    </div>

    <div class="section">
      <div class="section-title"><h3>${icon('layers')} Nirmata — four pillars</h3></div>
      <div class="pillars" id="pillars"></div>
    </div>

    <div class="section" id="matrixAnchor">
      <div class="section-title"><h3>${icon('target')} Opportunity matrix</h3><button class="btn sm" id="exportMatrix">${icon('download')} CSV</button></div>
      <div class="two-col" style="align-items:start">
        <div class="table-wrap xscroll">
          <table id="matrixTable"><thead><tr><th>Opportunity</th><th>Priority</th><th>Market size</th><th>Confidence</th><th>Window</th></tr></thead><tbody></tbody></table>
        </div>
        <div class="panel"><div class="panel-h"><h4>${icon('scatter-chart')} Priority vs confidence</h4></div><div class="chart-box"><canvas id="matrixChart"></canvas></div>
          <div class="legend"><span><i style="background:var(--sev-critical)"></i>Critical</span><span><i style="background:var(--sev-high)"></i>High</span><span><i style="background:var(--cyan)"></i>Strategic/Medium</span></div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title"><h3>${icon('git-branch')} Scenarios lab — 2026 → 2035</h3></div>
      <div class="cards" id="scenarios" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))"></div>
    </div>`;

  // frames
  $('#frameTabs').innerHTML=D.FRAMES.map(f=>`<button class="frame-tab ${f.id===currentFrame?'active':''}" data-f="${f.id}"><span class="n">${f.n}</span>${f.title}</button>`).join('');
  $$('#frameTabs .frame-tab').forEach(t=>t.addEventListener('click',()=>{currentFrame=t.dataset.f;$$('#frameTabs .frame-tab').forEach(x=>x.classList.toggle('active',x===t));drawFrame();}));
  drawFrame();
  $('#frameAtom').addEventListener('click',()=>{const f=D.FRAMES.find(x=>x.id===currentFrame);openAtom('Regenerate the strategy frame "'+f.title+'" for Nirmata given the current agricultural crisis. Terse bullets, cite sources.');});

  // pillars
  $('#pillars').innerHTML=D.PILLARS.map(p=>`<div class="pillar"><div class="pn">${p.n}</div><h4>${esc(p.name)}</h4><p>${esc(p.desc)}</p></div>`).join('');

  // matrix
  const priBadge={critical:'critical',high:'high',strategic:'moderate',medium:'neutral'};
  $('#matrixTable tbody').innerHTML=D.OPP_MATRIX.map(o=>`
    <tr><td><strong>${esc(o.opp)}</strong><div class="sub">${esc(o.sub)}</div></td>
    <td>${badge(priBadge[o.pri]||'neutral')}</td>
    <td class="mono" style="font-size:12px">${esc(o.size)}</td>
    <td class="mono">${o.conf}%</td>
    <td class="mono" style="font-size:12px">${esc(o.time)}</td></tr>`).join('');
  $('#exportMatrix').addEventListener('click',exportMatrixCSV);

  // scenarios
  $('#scenarios').innerHTML=D.SCENARIOS.map(s=>`
    <div class="card">
      <div class="ch"><h4>${esc(s.name)}</h4>${badge(s.tone)}</div>
      <div class="src-line"><span class="mono">P ≈ ${s.prob}%</span> · ${esc(s.horizon)}</div>
      <div class="track"><div class="fill" style="width:${s.prob}%;background:var(--sev-${s.tone})"></div></div>
      <p>${esc(s.summary)}</p>
      <div class="tag-cloud">${s.drivers.map(d=>`<span class="chip">${esc(d)}</span>`).join('')}</div>
      <p style="font-size:12px;color:var(--cyan);margin-top:4px"><strong>Nirmata:</strong> ${esc(s.nirmata)}</p>
    </div>`).join('');
  refreshIcons();
}
function drawFrame(){
  const f=D.FRAMES.find(x=>x.id===currentFrame);
  $('#frameBody').innerHTML=`<div class="panel-h"><h4>${icon('list-checks')} ${f.title}</h4><span class="chip">demo intelligence · ATOM can refresh</span></div>
    <ul style="margin:6px 0 0;padding-left:20px;color:var(--text-dim);line-height:2;font-size:14px">${f.bullets.map(b=>`<li>${esc(b)}</li>`).join('')}</ul>`;
  refreshIcons();
}
function drawStrategyChart(){
  if(!window.Chart||strategyChart||!$('#matrixChart'))return;
  const cc={critical:'#e2483d',high:'#e8913c',strategic:'#5fb3c4',medium:'#5fb3c4'};
  const priN={critical:4,high:3,strategic:2,medium:1};
  strategyChart=new Chart($('#matrixChart'),{
    type:'scatter',
    data:{datasets:D.OPP_MATRIX.map(o=>({label:o.opp,data:[{x:o.conf,y:priN[o.pri]||1}],backgroundColor:cc[o.pri]||'#7d8794',pointRadius:8,pointHoverRadius:11}))},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+' — conf '+ctx.parsed.x+'%'}}},
      scales:{x:{title:{display:true,text:'Confidence %',color:'#8b877d'},min:60,max:100,grid:{color:'rgba(255,255,255,.06)'},ticks:{color:'#8b877d'}},
        y:{title:{display:true,text:'Priority',color:'#8b877d'},min:0,max:5,grid:{color:'rgba(255,255,255,.06)'},ticks:{color:'#8b877d',callback:v=>({4:'Critical',3:'High',2:'Strategic',1:'Medium'}[v]||'')}}}}
  });
}

/* ================= SIMULATE / WAR ROOM ================= */
let simSel={pillar:null,threat:null};
function renderSimulate(p){
  p.innerHTML=`
    <div class="mode-head">
      <div class="eyebrow">War Room · Threat Simulation &amp; Intervention</div>
      <h2>Pillar <em>vs</em> threat</h2>
      <p class="lede">Select one Nirmata pillar and one systemic threat to model the intervention's effectiveness, outcome narration, and residual risk. This is a legible strategic simulator — pick a move on each side.</p>
    </div>
    <div class="sim-wrap">
      <div class="sim-col">
        <h4>${icon('shield')} Deploy a pillar</h4>
        <div class="board" id="simPillars"></div>
      </div>
      <div class="sim-col">
        <h4>${icon('alert-triangle')} Against a threat</h4>
        <div class="board" id="simThreats"></div>
      </div>
    </div>
    <div class="section">
      <div class="section-title"><h3>${icon('crosshair')} Outcome</h3>
        <div class="btn-row"><button class="btn sm" id="simRestart">${icon('rotate-ccw')} Restart</button><button class="btn sm primary" id="simAtom">${icon('sparkles')} Ask ATOM to war-game</button></div>
      </div>
      <div class="sim-console" id="simConsole"></div>
    </div>`;
  $('#simPillars').innerHTML=D.SIM_PILLARS.map(p=>`
    <button class="move-card pillar-c" data-id="${p.id}"><div class="mi">${p.short}</div><div><div class="mt">${esc(p.name)}</div><div class="md">${esc(p.desc)}</div></div></button>`).join('');
  $('#simThreats').innerHTML=D.SIM_THREATS.map(t=>`
    <button class="move-card threat" data-id="${t.id}"><div class="mi">${t.short}</div><div><div class="mt">${esc(t.name)}</div><div class="md">${badge(t.sev)}</div></div></button>`).join('');
  $$('#simPillars .move-card').forEach(b=>b.addEventListener('click',()=>{simSel.pillar=b.dataset.id;$$('#simPillars .move-card').forEach(x=>x.classList.toggle('selected',x===b));resolveSim();}));
  $$('#simThreats .move-card').forEach(b=>b.addEventListener('click',()=>{simSel.threat=b.dataset.id;$$('#simThreats .move-card').forEach(x=>x.classList.toggle('selected',x===b));resolveSim();}));
  $('#simRestart').addEventListener('click',()=>{simSel={pillar:null,threat:null};$$('.move-card').forEach(x=>x.classList.remove('selected'));resolveSim();});
  $('#simAtom').addEventListener('click',()=>{
    const pn=simSel.pillar?D.SIM_PILLARS.find(x=>x.id===simSel.pillar).name:'a Nirmata pillar';
    const tn=simSel.threat?D.SIM_THREATS.find(x=>x.id===simSel.threat).name:'a systemic threat';
    openAtom('War-game deploying '+pn+' against '+tn+'. Give moves, counter-moves, effectiveness estimate and residual risk.');
  });
  resolveSim();
}
function resolveSim(){
  const c=$('#simConsole'); if(!c)return;
  if(!simSel.pillar||!simSel.threat){
    c.innerHTML=`<div class="outcome muted">${icon('mouse-pointer-click','ic')}  Select one pillar and one threat to model an engagement.\n\nEach pairing returns an effectiveness estimate, narration, and residual risk drawn from the strategic model.</div>`;
    refreshIcons(); return;
  }
  const key=simSel.pillar+'_'+simSel.threat, o=D.SIM_OUTCOMES[key];
  const pn=D.SIM_PILLARS.find(x=>x.id===simSel.pillar).name, tn=D.SIM_THREATS.find(x=>x.id===simSel.threat).name;
  const eff=o?o.eff:50, line=o?o.line:'Model pending for this pairing.';
  const rating=eff>=75?'Decisive':eff>=55?'Strong':eff>=40?'Partial':'Weak';
  const col=eff>=75?'var(--sev-stable)':eff>=55?'var(--cyan)':eff>=40?'var(--sev-moderate)':'var(--sev-critical)';
  c.innerHTML=`
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <span class="chip cyan">${esc(pn)}</span>${icon('arrow-right','ic')}<span class="chip">${esc(tn)}</span>
      <span class="badge ${eff>=55?'stable':eff>=40?'moderate':'critical'}" style="margin-left:auto"><span class="d"></span>${rating} · ${eff}%</span>
    </div>
    <div class="gauge"><span class="mono" style="font-size:11px;color:var(--muted)">EFFECT</span><div class="track"><div class="fill" style="width:${eff}%;background:${col}"></div></div></div>
    <div class="outcome">${esc(line)}\n\nResidual risk: ${100-eff}% — pair with a complementary pillar to close the gap.</div>`;
  refreshIcons();
}

/* ================= RESOURCES / DATA ================= */
const RES_TABS=[
  {id:'markets',label:'Markets & Supply'},
  {id:'water',label:'Climate & Water'},
  {id:'soil',label:'Soil / Fulvic-Humic'},
  {id:'ai',label:'AI Opportunity Gaps'},
  {id:'chain',label:'Blockchain Readiness'},
  {id:'biotech',label:'Regenerative Biotech'},
  {id:'industry',label:'Industry Web'},
  {id:'countries',label:'Country Profiles'},
];
let currentResTab='markets', resCharts={};
function renderResources(p){
  p.innerHTML=`
    <div class="mode-head">
      <div class="eyebrow">Resources &amp; Data Suite</div>
      <h2>The evidence <em>base</em></h2>
      <p class="lede">Deep reference across markets, water, soil science, AI whitespace, tokenization, biotech, industry dependencies, and country profiles. Organized in sub-tabs — no endless scroll.</p>
    </div>
    <div class="subtabs" id="resTabs" role="tablist"></div>
    ${RES_TABS.map(t=>`<div class="subpanel" id="res-${t.id}"></div>`).join('')}`;
  $('#resTabs').innerHTML=RES_TABS.map(t=>`<button class="subtab ${t.id===currentResTab?'active':''}" data-t="${t.id}" role="tab">${t.label}</button>`).join('');
  $$('#resTabs .subtab').forEach(b=>b.addEventListener('click',()=>{
    currentResTab=b.dataset.t;
    $$('#resTabs .subtab').forEach(x=>x.classList.toggle('active',x===b));
    $$('.subpanel').forEach(x=>x.classList.toggle('active',x.id==='res-'+currentResTab));
    drawResourceCharts(currentResTab);
  }));
  // build all sub-panels (static content is cheap; charts drawn lazily)
  buildResMarkets(); buildResWater(); buildResSoil(); buildResAI();
  buildResChain(); buildResBiotech(); buildResIndustry(); buildResCountries();
  $('#res-'+currentResTab).classList.add('active');
  refreshIcons();
}
function buildResMarkets(){
  $('#res-markets').innerHTML=`
    <div class="section-title"><h3>${icon('trending-up')} Commodity prices — 24 months (index)</h3><span class="meta">USDA / FAO composite</span></div>
    <div class="panel"><div class="chart-box tall"><canvas id="chartPrices"></canvas></div></div>
    <div class="section">
      <div class="section-title"><h3>${icon('route')} Grain trade flows &amp; chokepoints</h3></div>
      <div class="two-col" style="align-items:start">
        <div class="table-wrap xscroll"><table><thead><tr><th>From</th><th>To</th><th>Crop</th><th>Vol (Mmt)</th><th>Risk</th></tr></thead><tbody>
          ${D.GRAIN_FLOWS.map(f=>`<tr><td>${esc(f.from)}</td><td>${esc(f.to)}</td><td class="mono">${esc(f.crop)}</td><td class="mono">${f.vol}</td><td>${badge(f.risk)}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="stack">${D.CHOKEPOINTS.map(c=>`<div class="panel"><div class="panel-h"><h4>${icon('anchor')} ${esc(c.name)}</h4>${badge(c.status)}</div><div class="src-line">${esc(c.share)}</div><p style="font-size:12.5px;color:var(--text-dim);margin:6px 0 0">${esc(c.note)}</p></div>`).join('')}</div>
      </div>
    </div>`;
}
function buildResWater(){
  $('#res-water').innerHTML=`
    <div class="section-title"><h3>${icon('droplets')} Aquifer depletion</h3><span class="meta">NASA GRACE</span></div>
    <div class="panel"><div class="chart-box tall"><canvas id="chartAquifer"></canvas></div></div>
    <div class="section">
      <div class="section-title"><h3>${icon('waves')} Virtual water trade (embedded water export)</h3></div>
      <div class="table-wrap xscroll"><table><thead><tr><th>From</th><th>To</th><th>Crop</th><th>Volume</th><th>Water / yr</th><th>Operator</th></tr></thead><tbody>
        ${D.WATER_TRADE.map(w=>`<tr><td>${esc(w.from)}</td><td>${esc(w.to)}</td><td>${esc(w.crop)}</td><td class="mono">${esc(w.vol)}</td><td class="mono">${esc(w.water)}</td><td>${esc(w.via)}</td></tr>`).join('')}
      </tbody></table></div>
    </div>`;
}
function buildResSoil(){
  $('#res-soil').innerHTML=`
    <div class="section-title"><h3>${icon('sprout')} Soil intelligence — fulvic &amp; humic</h3></div>
    <div class="kpi-strip">${D.SOIL_MARKETS.map(m=>`<div class="kpi c-cyan"><div class="val">${esc(m.v)}</div><div class="lbl">${esc(m.k)}</div><div class="delta flat">${esc(m.sub)}</div><div class="src">${esc(m.src)}</div></div>`).join('')}</div>
    <div class="section"><div class="section-title"><h3>${icon('list')} Functional benefits</h3></div>
      <div class="tag-cloud">${D.SOIL_BENEFITS.map(b=>`<span class="chip cyan">${esc(b)}</span>`).join('')}</div>
      <div class="panel" style="margin-top:14px"><p style="margin:0;color:var(--text-dim)">Fulvic and humic acids are low-molecular-weight carbon molecules that chelate nutrients, retain water, and stimulate soil microbiome activity. The commercial gap is an <strong>AI dosing + diagnostics platform</strong> — nobody has integrated real-time microbiome sensing with biostimulant optimization at scale. This is the Nirmata Regenerative Biology wedge.</p></div>
    </div>`;
}
function buildResAI(){
  $('#res-ai').innerHTML=`
    <div class="section-title"><h3>${icon('radar')} AI opportunity-gap radar</h3><span class="meta">urgency vs solution maturity</span></div>
    <div class="two-col" style="align-items:start">
      <div class="panel"><div class="chart-box tall"><canvas id="chartAI"></canvas></div>
        <div class="legend"><span><i style="background:var(--sev-critical)"></i>Urgency</span><span><i style="background:var(--cyan)"></i>Solution maturity</span></div></div>
      <div class="table-wrap xscroll"><table><thead><tr><th>Gap</th><th>Urgency</th><th>Maturity</th><th>Whitespace</th></tr></thead><tbody>
        ${D.AI_GAPS.map(g=>{const ws=g.urgency-g.maturity;return `<tr><td>${esc(g.name)}</td><td class="mono">${g.urgency}</td><td class="mono">${g.maturity}</td><td>${badge(ws>60?'critical':ws>45?'high':ws>30?'moderate':'stable')}</td></tr>`;}).join('')}
      </tbody></table></div>
    </div>`;
}
function buildResChain(){
  const st={live:'stable',pilot:'moderate',gap:'critical'};
  $('#res-chain').innerHTML=`
    <div class="section-title"><h3>${icon('link')} Agri-commodity tokenization trajectory</h3><span class="meta">$B market · World Bank / RWA.xyz</span></div>
    <div class="panel"><div class="chart-box tall"><canvas id="chartToken"></canvas></div></div>
    <div class="section"><div class="section-title"><h3>${icon('check-check')} Use-case readiness</h3></div>
      <div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">
      ${D.TOKEN_USECASES.map(u=>`<div class="card"><div class="ch"><h4 style="font-size:13.5px">${esc(u.t)}</h4></div><div>${badge(st[u.status])}</div></div>`).join('')}</div>
      <div class="panel" style="margin-top:14px"><p style="margin:0;color:var(--text-dim)">The critical gap: <strong>no post-quantum-secure agri-commodity settlement standard exists.</strong> NIST has published PQC standards with a 24-month commercial migration clock — the platform that ships quantum-secure grain/carbon settlement first sets the standard for a $110B (2030) → $1.4T (2040) market. Nirmata Secure Infrastructure edge.</p></div>
    </div>`;
}
function buildResBiotech(){
  const st={market:'stable',approved:'moderate',trial:'high',research:'neutral'};
  $('#res-biotech').innerHTML=`
    <div class="section-title"><h3>${icon('dna')} Regenerative biology pipeline</h3></div>
    <div class="cards">${D.BIOTECH_PIPELINE.map(b=>`
      <div class="card"><div class="ch"><span class="chip">${esc(b.org)}</span>${badge(st[b.stage])}</div><h4>${esc(b.name)}</h4><p>${esc(b.desc)}</p><div class="cf"><span class="chip cyan">${b.stage.toUpperCase()}</span></div></div>`).join('')}</div>`;
}
function buildResIndustry(){
  $('#res-industry').innerHTML=`
    <div class="section-title"><h3>${icon('network')} Correlated-industry dependency web</h3><span class="meta">dependency on agriculture · 0–100</span></div>
    <div class="cards">${D.INDUSTRIES.map(i=>`
      <div class="card"><div class="ch"><h4>${esc(i.t)}</h4><span class="mono muted">${i.dep}</span></div>
      <div class="track"><div class="fill" style="width:${i.dep}%;background:var(--cyan)"></div></div>
      <p>${esc(i.d)}</p></div>`).join('')}</div>`;
}
function buildResCountries(){
  const rows=[...D.COUNTRIES].sort((a,b)=>b.ipc-a.ipc||b.hungerPct-a.hungerPct);
  $('#res-countries').innerHTML=`
    <div class="section-title"><h3>${icon('flag')} Country intelligence profiles</h3><span class="meta">click a row for full profile</span></div>
    <div class="table-wrap xscroll"><table><thead><tr><th>Country</th><th>IPC</th><th>Insecure %</th><th>Conflict</th><th>Climate</th><th>Water</th><th>Status</th></tr></thead><tbody>
      ${rows.map(c=>`<tr data-code="${c.code}" style="cursor:pointer"><td>${c.flag} ${esc(c.name)}</td><td class="mono">${c.ipc}</td><td class="mono">${c.hungerPct}%</td><td class="mono">${c.conflict}</td><td class="mono">${c.climate}</td><td class="mono">${c.water}</td><td>${badge(c.tl)}</td></tr>`).join('')}
    </tbody></table></div>`;
  $$('#res-countries tbody tr').forEach(r=>r.addEventListener('click',()=>showCountry(r.dataset.code)));
}
function drawResourceCharts(tab){
  if(!window.Chart) return;
  const axis={grid:{color:'rgba(255,255,255,.06)'},ticks:{color:'#8b877d',font:{size:11}}};
  const legendOpt={labels:{color:'#b4afa4',font:{size:11},boxWidth:12}};
  if(tab==='markets'&&!resCharts.prices&&$('#chartPrices')){
    const cols={wheat:'#e2483d',rice:'#5fb3c4',maize:'#e8913c',soy:'#5ba86f',coffee:'#bf8f5f',cocoa:'#d9b23a'};
    resCharts.prices=new Chart($('#chartPrices'),{type:'line',
      data:{labels:D.MONTHS_24,datasets:Object.keys(D.COMMODITY_PRICES).map(k=>{const s=D.COMMODITY_PRICES[k],b=s[0];return {label:k,data:s.map(v=>Math.round(v/b*1000)/10),borderColor:cols[k],backgroundColor:'transparent',borderWidth:2,pointRadius:0,tension:.3};})},
      options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:legendOpt,tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.parsed.y} (base 100 = ${D.MONTHS_24[0]})`}}},scales:{x:axis,y:{...axis,title:{display:true,text:'Index (base 100)',color:'#8b877d',font:{size:11}}}}}});
  }
  if(tab==='water'&&!resCharts.aquifer&&$('#chartAquifer')){
    const aq=[...D.AQUIFERS].sort((a,b)=>b.depletion-a.depletion);
    resCharts.aquifer=new Chart($('#chartAquifer'),{type:'bar',
      data:{labels:aq.map(a=>a.name),datasets:[{label:'Depletion %',data:aq.map(a=>a.depletion),backgroundColor:aq.map(a=>({critical:'#e2483d',high:'#e8913c',moderate:'#d9b23a'}[a.tl]||'#5ba86f'))}]},
      options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{afterLabel:ctx=>'~'+aq[ctx.dataIndex].years+' yr to critical'}}},scales:{x:{...axis,max:100},y:{...axis,ticks:{color:'#b4afa4',font:{size:10}}}}}});
  }
  if(tab==='ai'&&!resCharts.ai&&$('#chartAI')){
    resCharts.ai=new Chart($('#chartAI'),{type:'radar',
      data:{labels:D.AI_GAPS.map(g=>g.name),datasets:[
        {label:'Urgency',data:D.AI_GAPS.map(g=>g.urgency),borderColor:'#e2483d',backgroundColor:'rgba(226,72,61,.15)',borderWidth:2,pointRadius:2},
        {label:'Solution maturity',data:D.AI_GAPS.map(g=>g.maturity),borderColor:'#5fb3c4',backgroundColor:'rgba(95,179,196,.12)',borderWidth:2,pointRadius:2}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:legendOpt},scales:{r:{angleLines:{color:'rgba(255,255,255,.08)'},grid:{color:'rgba(255,255,255,.08)'},pointLabels:{color:'#b4afa4',font:{size:10}},ticks:{color:'#5f5c55',backdropColor:'transparent'},min:0,max:100}}}});
  }
  if(tab==='chain'&&!resCharts.token&&$('#chartToken')){
    resCharts.token=new Chart($('#chartToken'),{type:'line',
      data:{labels:D.TOKEN_TRAJ.years,datasets:[{label:'Tokenized agri market ($B)',data:D.TOKEN_TRAJ.vals,borderColor:'#5fb3c4',backgroundColor:'rgba(95,179,196,.14)',borderWidth:2,fill:true,tension:.35,pointRadius:3}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:legendOpt},scales:{x:axis,y:{...axis,type:'logarithmic',title:{display:true,text:'$B (log)',color:'#8b877d'}}}}});
  }
}

/* ================= ATOM (mode + panel share transcript) ================= */
const ATOM_MODES=[{id:'quick',label:'Quick'},{id:'reasoning',label:'Reason'},{id:'deep',label:'Deep'},{id:'chat',label:'Chat'}];
let atomMode='quick';
let atomHistory=[]; // {role, content}
const ATOM_SUGGEST=[
  'Give me a 5-bullet executive brief on the global food crisis right now.',
  'Which country should Nirmata prioritize for a soil-intelligence pilot, and why?',
  'What is the strongest counter to the FARMPEC cartel scenario?',
  'Forecast wheat prices through Q4 2026 with confidence and 3 sources.',
];
function buildAtom(){
  $('#atomModes').innerHTML=ATOM_MODES.map(m=>`<button class="atom-mode ${m.id===atomMode?'active':''}" data-m="${m.id}">${m.label}</button>`).join('');
  $$('#atomModes .atom-mode').forEach(b=>b.addEventListener('click',()=>{atomMode=b.dataset.m;$$('#atomModes .atom-mode').forEach(x=>x.classList.toggle('active',x===b));}));
  $('#atomSend').addEventListener('click',()=>sendAtom());
  const ta=$('#atomInput');
  ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendAtom();}});
  ta.addEventListener('input',()=>{ta.style.height='auto';ta.style.height=Math.min(120,ta.scrollHeight)+'px';});
  renderAtomBody();
}
function renderAtomBody(){
  const b=$('#atomBody');
  if(!atomHistory.length){
    b.innerHTML=`<div class="atom-suggest"><div class="sh">Suggested prompts</div>${ATOM_SUGGEST.map(s=>`<button data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
    $$('#atomBody .atom-suggest button').forEach(btn=>btn.addEventListener('click',()=>{$('#atomInput').value=btn.dataset.q;sendAtom();}));
  } else {
    b.innerHTML=atomHistory.map(m=>`<div class="atom-msg ${m.role}"><div class="who">${m.role==='user'?'You':'ATOM'}</div><div class="bubble">${m.pending?'<span class="spinner"></span> analyzing…':esc(m.content)}</div></div>`).join('');
    b.scrollTop=b.scrollHeight;
  }
}
function openAtom(prefill){
  closeDrawer(); closeMobileNav();
  $('#atom').classList.add('open'); $('#atom').setAttribute('aria-hidden','false');
  if(prefill){ $('#atomInput').value=prefill; setTimeout(sendAtom,50); }
  else setTimeout(()=>$('#atomInput').focus(),120);
}
function closeAtom(){ $('#atom').classList.remove('open'); $('#atom').setAttribute('aria-hidden','true'); }
function renderAtomMode(p){
  p.innerHTML=`
    <div class="mode-head">
      <div class="eyebrow">ATOM · Nirmata Intelligence Terminal</div>
      <h2>Ask <em>ATOM</em></h2>
      <p class="lede">ATOM is the strategic agent embedded in the command center. It correlates crisis intelligence through Nirmata's four pillars. Queries route only through the server-side <span class="mono">/api/atom</span> proxy — no keys are ever exposed client-side.</p>
    </div>
    <div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">
      ${ATOM_SUGGEST.map(s=>`<button class="card" data-q="${esc(s)}" style="text-align:left;cursor:pointer"><div class="ch">${icon('sparkles','ic')}${icon('arrow-up-right','ic')}</div><h4 style="font-size:14px">${esc(s)}</h4></button>`).join('')}
    </div>
    <div class="btn-row" style="margin-top:18px"><button class="btn primary" id="openAtomPanel">${icon('message-square')} Open ATOM terminal</button></div>`;
  $$('#panel-atom .card').forEach(c=>c.addEventListener('click',()=>openAtom(c.dataset.q)));
  $('#openAtomPanel').addEventListener('click',()=>openAtom());
}
async function sendAtom(){
  const ta=$('#atomInput'); const q=ta.value.trim(); if(!q) return;
  ta.value=''; ta.style.height='auto';
  atomHistory.push({role:'user',content:q});
  const pending={role:'assistant',content:'',pending:true}; atomHistory.push(pending);
  renderAtomBody(); $('#atomSend').disabled=true;
  const ctx = `Modes available: Command/Map/Intel/Strategy/WarRoom/Data. As-of ${D.AS_OF}. Key figures: 295M acute food-insecure, 5 IPC-5 countries, FFPI 148.2, wheat stocks-to-use 26.4%, fertilizer +35%.`;
  try{
    const res=await fetch('/api/atom',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({messages:atomHistory.filter(m=>!m.pending).map(m=>({role:m.role,content:m.content})),mode:atomMode,stream:false,context:ctx})});
    if(!res.ok){ throw new Error('HTTP '+res.status); }
    const data=await res.json();
    const content = data?.choices?.[0]?.message?.content || 'No content returned.';
    pending.content=content; pending.pending=false;
  }catch(err){
    pending.pending=false;
    const code=/^HTTP (\d{3})$/.exec(String(err&&err.message));
    const hint=code?' (server returned '+code[1]+')':'';
    pending.content='⚠ ATOM is temporarily unavailable'+hint+'.\n\nThe live agent needs the PPLX_KEY environment variable configured on the server. All bundled intelligence in this command center remains fully available offline — try the Command, Intel, Strategy and War Room modes.';
  }
  renderAtomBody(); $('#atomSend').disabled=false; refreshIcons();
}

/* ================= EXPORTS ================= */
function download(name,content,type){const b=new Blob([content],{type});const u=URL.createObjectURL(b);const a=el('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
function toCSV(rows){return rows.map(r=>r.map(c=>{const s=String(c==null?'':c);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}).join(',')).join('\n');}
function exportIntelCSV(){
  const rows=[['date','source','category','severity','region','headline','confidence','affected']];
  filteredIntel().forEach(c=>rows.push([c.date,c.src,c.cat,c.tl,c.region,c.head,c.conf+'%',c.pop]));
  download('agri-nexus-intel-'+D.AS_OF+'.csv',toCSV(rows),'text/csv');
}
function exportMatrixCSV(){
  const rows=[['opportunity','priority','market_size','confidence','window','edge','gap']];
  D.OPP_MATRIX.forEach(o=>rows.push([o.opp,o.pri,o.size,o.conf+'%',o.time,o.edge,o.gap]));
  download('agri-nexus-opportunity-matrix.csv',toCSV(rows),'text/csv');
}
function printBrief(){
  const crit=D.INTEL_CARDS.filter(c=>c.tl==='critical').slice(0,6);
  const markets=D.INTEL_CARDS.filter(c=>c.cat==='MARKET SIGNAL').slice(0,5);
  const w=window.open('','_blank'); if(!w){alert('Enable pop-ups to print the briefing.');return;}
  w.document.write(`<html><head><title>AGRI-NEXUS Daily Brief ${D.AS_OF}</title>
    <style>body{font-family:Georgia,serif;max-width:720px;margin:32px auto;color:#111;line-height:1.55;padding:0 20px}
    h1{font-size:22px;border-bottom:3px solid #e2483d;padding-bottom:8px}h2{font-size:14px;color:#e2483d;margin-top:22px;text-transform:uppercase;letter-spacing:.05em}
    .kpis{display:flex;flex-wrap:wrap;gap:14px;margin:14px 0}.kpi{border:1px solid #ccc;border-radius:6px;padding:8px 12px;font-size:13px}.kpi b{font-size:18px;display:block}
    li{margin:5px 0;font-size:13px}small{color:#666}</style></head><body>
    <h1>AGRI-NEXUS COMMAND CENTER — Daily Intelligence Brief</h1>
    <small>As of ${D.AS_OF} · Nirmata Holdings · Strategic Operations · Sources: FAO, FEWS NET, ACLED, WFP, USDA WASDE, NOAA, World Bank</small>
    <div class="kpis">${D.KPIS.map(k=>`<div class="kpi"><b>${k.val}</b>${k.lbl}<br><small>${k.src}</small></div>`).join('')}</div>
    <h2>Situation</h2><p>Five countries sit in confirmed famine (IPC-5). The FAO Food Price Index is 148.2 (+4.7% MoM); wheat stocks-to-use is at an 8-year low of 26.4%; fertilizer is up 35% since the Hormuz incident.</p>
    <h2>Top famine / conflict</h2><ul>${crit.map(c=>`<li><b>${c.head}</b> — ${c.body} <small>(${c.src}, ${c.date})</small></li>`).join('')}</ul>
    <h2>Market signals</h2><ul>${markets.map(c=>`<li><b>${c.head}</b> — ${c.body} <small>(${c.src})</small></li>`).join('')}</ul>
    <h2>Strategic read</h2><p>The intervention window is open. Nirmata's leverage concentrates in AI soil intelligence, post-quantum commodity settlement, and voice-first smallholder reach.</p>
    </body></html>`);
  w.document.close(); setTimeout(()=>w.print(),350);
}

/* ================= INIT ================= */
document.addEventListener('DOMContentLoaded',initGate);
if(document.readyState!=='loading')initGate();
})();
