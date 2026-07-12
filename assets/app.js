/* ============================================================
   AgriOS · A Nirmata Holdings Company — application controller
   Deterministic: modes render on first activation, single scroll.
   ============================================================ */
(function(){
'use strict';
const D = window.AGRI;
const PASSWORD = "FuckPutin"; // JS variable only — never persisted
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
  {id:'theater', label:'Theater', icon:'radar'},
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
  initTheme();
  bindShell();
  bindScrollProgress();
  buildAtom();
  buildCmdk();
  activateMode(bootStartMode());
  startLive();
  startIntel();
  refreshIcons();
  if(window.AGRI_COLLAB) window.AGRI_COLLAB.init();
}
/* If the URL carries shareable theater state, stash it and open the Theater. */
function bootStartMode(){
  try{
    if(window.THEATER_FILTERS && location.search){
      const s=window.THEATER_FILTERS.parseState(location.search);
      const hasTheater=(s.layers&&s.layers.length)||(s.commodity&&s.commodity.length)||(s.severity&&s.severity.length)||
        (s.category&&s.category.length)||(s.evidence&&s.evidence.length)||s.region||s.sel||s.sim;
      if(hasTheater){ window.__THEATER_PENDING__=s; return 'theater'; }
    }
  }catch(e){}
  return 'command';
}

/* Respect reduced motion for JS-driven animation */
const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function buildNav(){
  const nav=$('#modes');
  MODES.forEach(m=>{
    const b=el('button','mode-tab',`${icon(m.icon)}<span>${m.label}</span>`);
    b.dataset.mode=m.id;
    b.setAttribute('role','tab');
    b.setAttribute('aria-label',m.label+' mode');
    b.setAttribute('aria-selected','false');
    b.setAttribute('aria-controls','panel-'+m.id);
    b.id='tab-'+m.id;
    b.tabIndex=-1;
    b.addEventListener('click',()=>{activateMode(m.id); closeMobileNav();});
    b.addEventListener('keydown',handleTabKeys);
    nav.appendChild(b);
  });
  // Panels are tabpanels controlled by the tablist.
  $$('.mode-panel').forEach(p=>{
    p.setAttribute('role','tabpanel');
    p.setAttribute('tabindex','0');
    if(p.dataset.mode) p.setAttribute('aria-labelledby','tab-'+p.dataset.mode);
  });
}

// Roving-tabindex arrow-key navigation across the mode tablist.
function handleTabKeys(e){
  const keys=['ArrowRight','ArrowLeft','Home','End'];
  if(keys.indexOf(e.key)===-1) return;
  e.preventDefault();
  const tabs=$$('.mode-tab');
  const cur=tabs.indexOf(e.currentTarget);
  let next=cur;
  if(e.key==='ArrowRight') next=(cur+1)%tabs.length;
  else if(e.key==='ArrowLeft') next=(cur-1+tabs.length)%tabs.length;
  else if(e.key==='Home') next=0;
  else if(e.key==='End') next=tabs.length-1;
  const t=tabs[next];
  if(t){ activateMode(t.dataset.mode); t.focus(); }
}

function activateMode(id){
  $$('.mode-tab').forEach(t=>{
    const on=t.dataset.mode===id;
    t.classList.toggle('active',on);
    t.setAttribute('aria-selected',on?'true':'false');
    t.tabIndex=on?0:-1;
  });
  $$('.mode-panel').forEach(p=>p.classList.toggle('active',p.dataset.mode===id));
  if(!rendered[id]){ renderMode(id); rendered[id]=true; }
  $('#workspace').scrollTop=0;
  refreshIcons();
  // lazy init heavy modules
  if(id==='map') setTimeout(initMap,60);
  if(id==='resources') setTimeout(()=>drawResourceCharts(currentResTab),60);
  if(id==='strategy') setTimeout(drawStrategyChart,60);
  // theater: pause its rAF loop when not visible; resume on entry
  if(window.THEATER&&window.THEATER.setActive){ if(id==='theater') setTimeout(()=>window.THEATER.setActive(true),60); else window.THEATER.setActive(false); }
}

function renderMode(id){
  const p=$('#panel-'+id);
  ({command:renderCommand,map:renderMap,theater:renderTheater,intel:renderIntel,strategy:renderStrategy,
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
  $('#openCmdk').addEventListener('click',()=>openCmdk());
  $('#cmdkScrim').addEventListener('click',closeCmdk);
  const oa=$('#openAlerts'); if(oa) oa.addEventListener('click',()=>{ if(window.AGRI_COLLAB) window.AGRI_COLLAB.openAlerts(); });
  const ib=$('#identityBtn'); if(ib) ib.addEventListener('click',()=>{
    if(window.AGRIOS_AUTH) window.AGRIOS_AUTH.open();
    else if(window.AGRI_COLLAB) window.AGRI_COLLAB.openIdentity();
  });
  // Owner-only manual refresh appears/disappears with account role.
  if(window.AGRIOS_AUTH) window.AGRIOS_AUTH.onChange(()=>{ if(rendered.resources && currentResTab==='feeds') drawSourceHealth(); });
  document.addEventListener('keydown',e=>{
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){ e.preventDefault(); toggleCmdk(); return; }
    if($('#cmdk').classList.contains('open')){ handleCmdkKeys(e); return; }
    if(e.key==='Escape'){
      if($('#atom').classList.contains('open')) closeAtom();
      else if($('#drawer').classList.contains('open')) closeDrawer();
      else closeMobileNav();
    }
  });
}
function closeMobileNav(){ $('#modes').classList.remove('open'); $('#navScrim').classList.remove('open'); $('#hamburger').setAttribute('aria-expanded','false'); }

/* ================= THEME (dark default; JS-memory only, no storage) =================
   Persistence via browser storage is prohibited, so preference lives in memory
   for the session and otherwise follows the OS via matchMedia. */
let themeState='dark';
function applyTheme(t){
  themeState=(t==='light')?'light':'dark';
  document.documentElement.setAttribute('data-theme',themeState);
  const btn=$('#themeToggle');
  if(btn){
    const toLight=themeState==='dark';
    btn.setAttribute('aria-pressed',themeState==='light'?'true':'false');
    btn.setAttribute('aria-label',toLight?'Switch to light theme':'Switch to dark theme');
  }
  // Re-theme token-bound charts already instantiated (colors read at build time).
  if(typeof rethemeCharts==='function') rethemeCharts();
}
function initTheme(){
  // Dark is the product default; honor an explicit OS light preference at load.
  let initial='dark';
  try{ if(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) initial='light'; }catch(e){}
  applyTheme(initial);
  const btn=$('#themeToggle');
  if(btn) btn.addEventListener('click',()=>applyTheme(themeState==='dark'?'light':'dark'));
}
// Rebuild token-bound charts so a theme switch recolors them.
function rethemeCharts(){
  try{
    if(typeof resCharts==='object'&&resCharts){
      Object.keys(resCharts).forEach(k=>{ if(resCharts[k]&&resCharts[k].destroy){ resCharts[k].destroy(); resCharts[k]=null; } });
      if(rendered.resources) drawResourceCharts(currentResTab);
    }
  }catch(e){}
}

/* Header scroll-progress rule bound to the single #workspace scroll region. */
function bindScrollProgress(){
  const ws=$('#workspace'), bar=$('#scrollProgress');
  if(!ws||!bar) return;
  const update=()=>{
    const max=ws.scrollHeight-ws.clientHeight;
    const pct=max>0?Math.min(100,Math.max(0,(ws.scrollTop/max)*100)):0;
    bar.style.width=pct.toFixed(1)+'%';
  };
  ws.addEventListener('scroll',update,{passive:true});
  update();
}

/* ================= LIVE DATA LAYER ================= */
let liveState={status:'connecting',events:[],sources:[],asOf:null,paused:false};
let liveTimer=null;
async function pollLive(){
  try{
    const ctrl=new AbortController();
    const to=setTimeout(()=>ctrl.abort(),9000);
    const res=await fetch('/api/live',{signal:ctrl.signal});
    clearTimeout(to);
    if(!res.ok) throw new Error('HTTP '+res.status);
    const data=await res.json();
    liveState.status=data.status||'degraded';
    liveState.events=Array.isArray(data.events)?data.events:[];
    liveState.sources=Array.isArray(data.sources)?data.sources:[];
    liveState.asOf=data.asOf||new Date().toISOString();
  }catch(err){
    liveState.status='degraded';
    liveState.events=[];
    liveState.sources=(liveState.sources.length?liveState.sources:[{name:'GDACS'},{name:'USGS'},{name:'NASA EONET'}]).map(s=>({name:s.name,status:'down',count:0}));
    liveState.asOf=new Date().toISOString();
  }
  paintLive();
}
function startLive(){
  paintLive(); // render connecting/bundled state immediately
  pollLive();
  liveTimer=setInterval(()=>{ if(!liveState.paused) pollLive(); },90000);
}
function paintLive(){
  updatePosture();
  updateTicker();
  updateLiveOverlay();
  if(rendered.intel) mergeLiveIntel();
}
function liveLabel(){ return liveState.status==='live'?'LIVE':liveState.status==='partial'?'PARTIAL':liveState.status==='connecting'?'SYNCING':'DEGRADED · BUNDLED INTEL'; }
function relTime(iso){
  if(!iso) return '';
  const d=new Date(iso), s=Math.max(0,(Date.now()-d.getTime())/1000);
  if(s<90) return 'just now';
  if(s<3600) return Math.round(s/60)+'m ago';
  if(s<86400) return Math.round(s/3600)+'h ago';
  return Math.round(s/86400)+'d ago';
}

/* ================= LIVE INTEL LAYER (fused /api/intel) =================
   Consumes the unified server-side aggregate and drives the Data-suite
   source-health rail. Distinguishes LIVE / STALE / MODELED / BUNDLED and
   always degrades to bundled intelligence — never throws to the UI. */
let intelData={status:'connecting',events:[],sources:[],summary:null,asOf:null,bundled:true};
let intelTimer=null;
// Map a source-health status to a traffic-light token (never colour alone).
function trafficFor(status){
  if(status==='ok') return {tl:'stable', label:'LIVE', icon:'check-circle-2'};
  if(status==='stale') return {tl:'moderate', label:'STALE', icon:'clock'};
  if(status==='disabled') return {tl:'neutral', label:'STANDBY', icon:'minus-circle'};
  if(status==='down') return {tl:'critical', label:'DOWN', icon:'alert-circle'};
  return {tl:'neutral', label:'—', icon:'circle'};
}
// Compact circular signal bubble with icon + text redundancy (a11y-safe).
function signalBubble(tl,label,extra){
  const title=label+(extra?(' · '+extra):'');
  return `<span class="signal ${tl}" role="img" aria-label="${esc(title)}" title="${esc(title)}"><span class="bub"></span><span class="sig-lbl mono">${esc(label)}</span>${extra?`<span class="sig-x mono">${esc(extra)}</span>`:''}</span>`;
}
function evidenceBadge(kind){
  const map={LIVE:'stable',STALE:'moderate',MODELED:'cyan',BUNDLED:'neutral'};
  return `<span class="ev-badge ev-${kind.toLowerCase()} ${map[kind]||'neutral'}" aria-label="Evidence: ${kind}">${esc(kind)}</span>`;
}
// Static, accessible legend for the traffic-light language.
function trafficLegend(){
  const items=[
    ['stable','GREEN','Nominal · live · ready'],
    ['moderate','AMBER','Watch · stale · degraded'],
    ['critical','RED','Critical · down · stand-down'],
    ['cyan','CYAN','Modeled · informational'],
  ];
  return `<div class="tl-legend" data-testid="traffic-legend" role="group" aria-label="Signal legend">
    ${items.map(([tl,k,d])=>`<span class="tl-leg ${tl}"><span class="bub"></span><b class="mono">${k}</b> ${esc(d)}</span>`).join('')}
  </div>`;
}
async function pollIntel(){
  try{
    const ctrl=new AbortController();
    const to=setTimeout(()=>ctrl.abort(),12000);
    const res=await fetch('/api/intel',{signal:ctrl.signal});
    clearTimeout(to);
    if(!res.ok) throw new Error('HTTP '+res.status);
    const data=await res.json();
    intelData.status=data.status||'degraded';
    intelData.events=Array.isArray(data.events)?data.events:[];
    intelData.sources=Array.isArray(data.sources)?data.sources:[];
    intelData.summary=data.summary||null;
    intelData.asOf=data.asOf||new Date().toISOString();
    intelData.bundled=!(data.summary&&data.summary.total>0);
  }catch(err){
    intelData.status='degraded';
    intelData.events=[];
    intelData.summary=null;
    intelData.bundled=true;
    intelData.asOf=new Date().toISOString();
  }
  paintIntel();
}
function startIntel(){ paintIntel(); pollIntel(); intelTimer=setInterval(pollIntel,120000); }
function paintIntel(){ if(rendered.resources && currentResTab==='feeds') drawSourceHealth(); }
function intelLabel(){
  const s=intelData.status;
  return s==='live'?'LIVE':s==='partial'?'PARTIAL':s==='stale'?'STALE':s==='connecting'?'SYNCING':'DEGRADED · BUNDLED INTEL';
}
/* Operational transparency: surface real outages, modeled proxies, staleness and
   confidence limits from live source-health/summary metadata. Invents no new
   risks — every line is derived from observed state. Rendered as a native
   <details> disclosure (keyboard-accessible, no color-only encoding). */
function knownGaps(){
  const sm=intelData.summary, st=intelData.status;
  const srcs=intelData.sources||[];
  const gaps=[];
  const down=srcs.filter(s=>s.status==='down').map(s=>s.name||s.id);
  const stale=srcs.filter(s=>s.status==='stale').map(s=>s.name||s.id);
  const off=srcs.filter(s=>s.status==='disabled').map(s=>s.name||s.id);
  if(down.length) gaps.push(['Source outage',`No live data from: ${down.join(', ')}. Affected signals fall back to modeled or bundled values.`]);
  if(stale.length) gaps.push(['Stale feeds',`Last successful pull is aging for: ${stale.join(', ')}. Treat counts as lagging indicators.`]);
  if(off.length) gaps.push(['Standby sources',`Not currently ingesting (config/standby): ${off.join(', ')}.`]);
  if(sm&&sm.modeled>0) gaps.push(['Modeled proxies',`${sm.modeled} of ${sm.total} events are modeled estimates, not direct observations. Labeled MODELED throughout.`]);
  if(intelData.bundled) gaps.push(['Bundled fallback active','Live aggregate is unavailable or empty; curated bundled intelligence is being shown. Figures are illustrative baselines, not real-time.']);
  if(st==='partial') gaps.push(['Partial coverage','Some sources responded and others did not; the picture is incomplete for this cycle.']);
  const conf=intelData.bundled?'LOW · bundled':(sm&&sm.sourcesOk===sm.sourcesTotal?'HIGH · all sources live':'MODERATE · partial live');
  if(!gaps.length) gaps.push(['No unresolved gaps detected','All tracked sources reported and no modeled fallback is active for this cycle.']);
  const rows=gaps.map(([t,d])=>`<li class="kg-item"><span class="kg-t">${esc(t)}</span><span class="kg-d">${esc(d)}</span></li>`).join('');
  return `<details class="known-gaps" data-testid="known-gaps">
    <summary>${icon('alert-triangle','ic')} Known gaps &amp; model limits <span class="kg-conf mono">confidence: ${esc(conf)}</span></summary>
    <ul class="kg-list">${rows}</ul>
    <p class="kg-foot mono">Derived from live source-health and aggregate metadata as of ${esc(intelData.asOf?relTime(intelData.asOf):'—')}. Modeled and observed values are labeled inline.</p>
  </details>`;
}
// Render the source-health rail + fused events for the Data → Live Feeds tab.
function drawSourceHealth(){
  const host=$('#res-feeds'); if(!host) return;
  const sm=intelData.summary;
  const st=intelData.status;
  const pillTl=st==='live'?'stable':st==='partial'?'moderate':st==='stale'?'moderate':st==='connecting'?'neutral':'critical';
  const sources=intelData.sources.length?intelData.sources:Object.keys(SEED_SOURCES).map(k=>SEED_SOURCES[k]);
  const rows=sources.map(s=>{
    const t=trafficFor(s.status||'connecting');
    const prov=s.homepage?`<a href="${esc(s.homepage)}" target="_blank" rel="noopener" class="prov-link">${icon('external-link','ic')} source</a>`:'';
    const cnt=(s.count!=null)?`${s.count}`:'—';
    return `<div class="sh-row" data-testid="source-row">
      <div class="sh-name"><span class="sh-dom mono">${esc(s.domain||'')}</span><span class="sh-nm">${esc(s.name||s.id)}</span></div>
      ${signalBubble(t.tl,t.label,cnt+' evt')}
      <div class="sh-meta mono">${esc((s.license||'').slice(0,28))}</div>
      <div class="sh-act">${prov}</div>
    </div>`;
  }).join('');
  const observed=sm?sm.observed:0, modeled=sm?sm.modeled:0;
  const stats=sm?`<span class="chip">${sm.total} events</span><span class="chip">${observed} observed</span><span class="chip">${modeled} modeled</span><span class="chip">${sm.sourcesOk}/${sm.sourcesTotal} sources live</span>`:'<span class="chip">bundled intelligence</span>';
  const evList=intelData.events.slice(0,10).map(e=>{
    const kind=e.evidence==='modeled'?'MODELED':(st==='stale'?'STALE':'LIVE');
    const tl=e.severity==='critical'?'critical':e.severity==='high'?'moderate':e.severity==='stable'?'stable':'moderate';
    const url=e.sourceUrl||(e.provenance&&e.provenance.sourceUrl)||'';
    return `<div class="row-item" ${url?`data-url="${esc(url)}"`:''} role="button" tabindex="0">
      <span class="ti-sev" style="width:9px;height:9px;border-radius:50%;background:var(--sev-${tl});flex:0 0 auto"></span>
      <div class="ri-main"><div class="t" style="white-space:normal">${esc(e.title)}</div><div class="s">${esc(e.source||'')} · ${esc(e.geography||'')} · ${relTime(e.observedAt)}</div></div>
      <div class="ri-end">${evidenceBadge(kind)}</div>
    </div>`;
  }).join('');
  const canRefresh=!!(window.AGRIOS_AUTH&&window.AGRIOS_AUTH.isOwner());
  const refreshCtl=canRefresh?`<button class="btn sm" id="intelRefreshBtn" data-testid="intel-refresh">${icon('refresh-cw')} Refresh sources</button>`:'';
  host.innerHTML=`
    <div class="section-title"><h3>${icon('activity')} Live source health</h3><span class="meta">unified public-feed aggregate · /api/intel</span></div>
    <div class="panel">
      <div class="panel-h"><h4>${icon('radio')} Aggregate status</h4>
        ${signalBubble(pillTl,intelLabel(),intelData.asOf?relTime(intelData.asOf):'')}${refreshCtl}</div>
      <div class="cf" style="margin:10px 0 4px">${stats}</div>
      ${trafficLegend()}
      ${knownGaps()}
    </div>
    <div class="section"><div class="section-title"><h3>${icon('server')} Per-source status</h3><span class="meta">green live · amber stale · red down · cyan modeled</span></div>
      <div class="sh-list" data-testid="source-health-list">${rows}</div>
    </div>
    <div class="section"><div class="section-title"><h3>${icon('rss')} Fused live events</h3></div>
      ${evList?`<div class="rows">${evList}</div>`:`<p class="muted" style="margin:0;font-size:13px">Live feeds unavailable — bundled intelligence remains fully operational. ${D.INTEL_CARDS.length} curated items available under Intel.</p>`}
    </div>`;
  $$('#res-feeds .row-item[data-url]').forEach(node=>{
    const url=node.dataset.url; const go=()=>{ if(url) window.open(url,'_blank','noopener'); };
    node.addEventListener('click',go); node.addEventListener('keydown',e=>{if(e.key==='Enter')go();});
  });
  const rb=$('#intelRefreshBtn');
  if(rb) rb.addEventListener('click',()=>{
    if(!(window.AGRIOS_AUTH&&window.AGRIOS_AUTH.isOwner())) return;
    rb.disabled=true; rb.classList.add('is-loading');
    window.AGRIOS_AUTH.authFetch('/api/intel?action=refresh',{method:'POST'})
      .then(r=>r.json().catch(()=>({})))
      .then(j=>{ if(j&&j.events){ intelData=Object.assign(intelData,{status:j.status,asOf:j.asOf,summary:j.summary,sources:j.sources||intelData.sources,events:j.events||intelData.events,bundled:false}); drawSourceHealth(); } })
      .catch(()=>{})
      .then(()=>{ if(rb){ rb.disabled=false; rb.classList.remove('is-loading'); } });
  });
  refreshIcons();
}
// Fallback seed used before the first /api/intel response resolves.
const SEED_SOURCES={
  gdacs:{id:'gdacs',name:'GDACS',domain:'hazard',status:'connecting',count:null,homepage:'https://www.gdacs.org'},
  usgs:{id:'usgs',name:'USGS',domain:'hazard',status:'connecting',count:null,homepage:'https://earthquake.usgs.gov'},
  eonet:{id:'eonet',name:'NASA EONET',domain:'hazard',status:'connecting',count:null,homepage:'https://eonet.gsfc.nasa.gov'},
  worldbank:{id:'worldbank',name:'World Bank',domain:'market',status:'connecting',count:null,homepage:'https://data.worldbank.org'},
  nass:{id:'nass',name:'USDA NASS',domain:'market',status:'connecting',count:null,homepage:'https://quickstats.nass.usda.gov'},
};

/* ================= COMMAND PALETTE ================= */
let cmdkItems=[], cmdkFiltered=[], cmdkActive=0;
function buildCmdkIndex(){
  const items=[];
  MODES.forEach(m=>items.push({group:'Modes',icon:m.icon,title:m.label,sub:'Switch mode',kbd:'',run:()=>activateMode(m.id)}));
  D.COUNTRIES.forEach(c=>items.push({group:'Countries',icon:'flag',title:c.name,sub:'IPC '+c.ipc+' · '+c.cont,run:()=>{activateMode('map');setTimeout(()=>showCountry(c.code),140);}}));
  D.MISSIONS.forEach(m=>items.push({group:'Missions',icon:'crosshair',title:m.code+' · '+m.objective,sub:m.pillar,run:()=>{activateMode('command');}}));
  D.INTEL_CARDS.slice(0,30).forEach(c=>items.push({group:'Intel',icon:'rss',title:c.head,sub:c.src+' · '+c.region,run:()=>{activateMode('intel');intelState.q=c.head.slice(0,24).toLowerCase();setTimeout(()=>{const s=$('#intelSearch');if(s){s.value=intelState.q;drawIntel();}},160);}}));
  const acts=[
    {icon:'sparkles',title:'Ask ATOM',sub:'Open intelligence terminal',run:()=>openAtom()},
    {icon:'printer',title:'Print daily brief',sub:'Action',run:()=>printBrief()},
    {icon:'download',title:'Export intel CSV',sub:'Action',run:()=>{activateMode('intel');setTimeout(exportIntelCSV,120);}},
    {icon:'swords',title:'Open War Room',sub:'Simulate intervention',run:()=>activateMode('simulate')},
    {icon:'git-compare',title:'Compare two countries',sub:'Map compare mode',run:()=>{activateMode('map');setTimeout(()=>openCompare(),160);}},
  ];
  acts.forEach(a=>items.push({group:'Actions',...a}));
  D.ATOM_PRESETS.forEach(p=>items.push({group:'ATOM prompts',icon:p.icon,title:p.label,sub:'Ask ATOM',run:()=>openAtom(p.prompt)}));
  cmdkItems=items;
}
function buildCmdk(){
  buildCmdkIndex();
  $('#cmdkInput').addEventListener('input',()=>filterCmdk());
}
function toggleCmdk(){ $('#cmdk').classList.contains('open')?closeCmdk():openCmdk(); }
function openCmdk(){
  closeAtom(); closeDrawer(); closeMobileNav();
  $('#cmdk').classList.add('open'); $('#cmdkScrim').classList.add('open'); $('#cmdk').setAttribute('aria-hidden','false');
  const inp=$('#cmdkInput'); inp.value=''; filterCmdk(); setTimeout(()=>inp.focus(),40);
}
function closeCmdk(){ $('#cmdk').classList.remove('open'); $('#cmdkScrim').classList.remove('open'); $('#cmdk').setAttribute('aria-hidden','true'); }
function filterCmdk(){
  const q=$('#cmdkInput').value.trim().toLowerCase();
  cmdkFiltered = !q ? cmdkItems.slice(0,40) : cmdkItems.filter(i=>(i.title+' '+i.sub+' '+i.group).toLowerCase().includes(q)).slice(0,40);
  cmdkActive=0; drawCmdk();
}
function drawCmdk(){
  const list=$('#cmdkList');
  if(!cmdkFiltered.length){ list.innerHTML='<div class="cmdk-empty">No matches. Try a country, mode, or “brief”.</div>'; return; }
  let html='', lastGroup='';
  cmdkFiltered.forEach((it,i)=>{
    if(it.group!==lastGroup){ html+=`<div class="cmdk-group">${esc(it.group)}</div>`; lastGroup=it.group; }
    html+=`<div class="cmdk-item ${i===cmdkActive?'active':''}" data-i="${i}" role="option">${icon(it.icon)}<div class="ci-main"><div class="ci-t">${esc(it.title)}</div><div class="ci-s">${esc(it.sub||'')}</div></div>${it.kbd?`<span class="ci-k">${esc(it.kbd)}</span>`:''}</div>`;
  });
  list.innerHTML=html;
  $$('#cmdkList .cmdk-item').forEach(node=>{
    node.addEventListener('click',()=>runCmdk(+node.dataset.i));
    node.addEventListener('mousemove',()=>{cmdkActive=+node.dataset.i;highlightCmdk();});
  });
  refreshIcons();
}
function highlightCmdk(){ $$('#cmdkList .cmdk-item').forEach(n=>n.classList.toggle('active',+n.dataset.i===cmdkActive)); }
function runCmdk(i){ const it=cmdkFiltered[i]; if(!it) return; closeCmdk(); setTimeout(()=>it.run(),20); }
function handleCmdkKeys(e){
  if(e.key==='Escape'){ e.preventDefault(); closeCmdk(); return; }
  if(e.key==='ArrowDown'){ e.preventDefault(); cmdkActive=Math.min(cmdkFiltered.length-1,cmdkActive+1); scrollCmdkActive(); }
  else if(e.key==='ArrowUp'){ e.preventDefault(); cmdkActive=Math.max(0,cmdkActive-1); scrollCmdkActive(); }
  else if(e.key==='Enter'){ e.preventDefault(); runCmdk(cmdkActive); }
}
function scrollCmdkActive(){ highlightCmdk(); const n=$(`#cmdkList .cmdk-item[data-i="${cmdkActive}"]`); if(n) n.scrollIntoView({block:'nearest'}); }

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
    <div class="posture" id="posture" data-testid="posture"></div>

    <div class="mode-head">
      <div class="eyebrow">Global Threat Dashboard · as of ${D.AS_OF}</div>
      <h2>The world is entering a <em>food-security polycrisis</em></h2>
      <p class="lede">Climate extremes, weaponized grain, fertilizer shocks and aquifer depletion are converging. This overview orients decision-makers before drilling into the map, intel feed, and strategic response.</p>
    </div>

    <div class="kpi-strip" id="cmdKpis"></div>

    <div class="section">
      <div class="section-title"><h3>${icon('crosshair')} Mission priority queue</h3><span class="meta">${D.MISSIONS.length} active objectives</span></div>
      <div class="missions" id="cmdMissions" data-testid="missions"></div>
    </div>

    <div class="section" id="teamMissionsSection" data-testid="team-missions-section">
      <div class="section-title"><h3>${icon('users-round')} Team missions</h3>
        <div class="btn-row"><span class="meta" id="teamMissionsMeta">persistent · team-scoped</span><button class="btn sm primary" id="newMissionBtn" data-testid="new-mission" hidden>${icon('plus')} New mission</button></div>
      </div>
      <div id="teamMissions"></div>
    </div>

    <div class="section">
      <div class="section-title"><h3>${icon('radio')} Live event rail</h3><span class="meta">public feeds · GDACS · USGS · NASA EONET</span></div>
      <div class="ticker" id="cmdTicker" data-testid="ticker"></div>
    </div>

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

  // KPIs (with count-up on the numeric portion)
  $('#cmdKpis').innerHTML = D.KPIS.map(k=>`
    <div class="kpi c-${k.sev}">
      <div class="val" data-countup="${esc(k.val)}">${esc(k.val)}</div>
      <div class="lbl">${esc(k.lbl)}</div>
      <div class="delta ${k.dir}">${k.dir==='up'?'▲':k.dir==='down'?'▼':'—'} ${esc(k.delta)}</div>
      <div class="src">${esc(k.src)}</div>
    </div>`).join('');
  $$('#cmdKpis .val[data-countup]').forEach(countUp);

  // Mission priority queue
  renderMissions();
  if(window.AGRI_COLLAB) window.AGRI_COLLAB.onCommandRendered();

  // Posture + ticker paint from current live state
  updatePosture(); updateTicker();

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

/* KPI count-up: animate only the numeric part, preserve prefix/suffix */
function countUp(node){
  const raw=node.getAttribute('data-countup')||node.textContent;
  const m=String(raw).match(/^([^\d.-]*)(-?[\d,]*\.?\d+)(.*)$/);
  if(!m||REDUCED){ node.textContent=raw; return; }
  const pre=m[1], suf=m[3], target=parseFloat(m[2].replace(/,/g,'')), dec=(m[2].split('.')[1]||'').length;
  const grouped=/,/.test(m[2]);
  const fmt=v=>{ let s=dec?v.toFixed(dec):String(Math.round(v)); if(grouped) s=Number(s).toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec}); return pre+s+suf; };
  const dur=900, t0=performance.now();
  const step=now=>{ const p=Math.min(1,(now-t0)/dur), e=1-Math.pow(1-p,3); node.textContent=fmt(target*e); if(p<1) requestAnimationFrame(step); else node.textContent=raw; };
  requestAnimationFrame(step);
}

/* Mission priority queue */
function renderMissions(){
  const wrap=$('#cmdMissions'); if(!wrap) return;
  const order={critical:0,high:1,moderate:2};
  const missions=[...D.MISSIONS].sort((a,b)=>(order[a.sev]-order[b.sev])||(b.conf-a.conf));
  wrap.innerHTML=missions.map(m=>`
    <div class="mission sev-${m.sev}" data-id="${m.id}">
      <div class="m-top"><span class="m-code">${esc(m.code)}</span><span class="m-owner">${esc(m.owner)}</span>${badge(m.sev)}</div>
      <h4>${esc(m.objective)}</h4>
      <div class="m-why">${esc(m.why)}</div>
      <div class="m-meta">
        <div class="mr">${icon('clock')} <span>${esc(m.window)}</span></div>
        <div class="mr">${icon('layers')} <span>${esc(m.pillar)}</span></div>
      </div>
      <div class="m-conf"><span class="cv">Confidence</span><div class="track"><div class="fill" style="width:${m.conf}%;background:var(--sev-${m.sev})"></div></div><span class="cv">${m.conf}%</span></div>
      <div class="m-acts">
        ${m.country?`<button class="btn sm" data-act="map">${icon('globe')} Map</button>`:''}
        <button class="btn sm" data-act="wargame">${icon('swords')} War-game</button>
        <button class="btn sm primary" data-act="atom">${icon('sparkles')} Ask ATOM</button>
      </div>
    </div>`).join('');
  $$('#cmdMissions .mission').forEach(node=>{
    const m=D.MISSIONS.find(x=>x.id===node.dataset.id);
    node.querySelectorAll('.m-acts .btn').forEach(btn=>btn.addEventListener('click',e=>{
      e.stopPropagation();
      const act=btn.dataset.act;
      if(act==='map'&&m.country){ activateMode('map'); setTimeout(()=>showCountry(m.country),140); }
      else if(act==='wargame'){ activateMode('simulate'); setTimeout(()=>presetSim(m.owner),160); }
      else if(act==='atom'){ openAtom('Advance mission '+m.code+': '+m.objective+'. Give a course of action with effectiveness, residual risk, dependencies and confidence.'); }
    }));
  });
  refreshIcons();
}

/* Threat posture header */
function updatePosture(){
  const host=$('#posture'); if(!host) return;
  const st=liveState.status;
  const crit=D.COUNTRIES.filter(c=>c.tl==='critical').length;
  const flashpoints=crit+D.MISSIONS.filter(m=>m.sev==='critical').length;
  const okSources=liveState.sources.filter(s=>s.status==='ok');
  const bundled=st==='degraded'||st==='connecting';
  const health = liveState.sources.length
    ? liveState.sources.map(s=>`<span class="sh-chip ${s.status==='ok'?'ok':'down'}">${s.status==='ok'?icon('check-circle-2'):icon('alert-circle')} ${esc(s.name)}${s.status==='ok'?` · ${s.count}`:' · down'}</span>`).join('')
    : `<span class="sh-chip bundled">${icon('database')} bundled intel</span>`;
  const bundledChip = bundled ? `<span class="sh-chip bundled">${icon('database')} bundled intel active</span>` : '';
  host.innerHTML=`
    <div class="posture-top">
      <div class="defcon">
        <div class="ring">D2</div>
        <div><div class="dl">Operational posture</div><div class="dv">ELEVATED · WATCH</div></div>
      </div>
      <div class="pstat"><span class="k">Mission clock</span><span class="v" id="postureClock">—</span></div>
      <div class="pstat"><span class="k">Active flashpoints</span><span class="v">${flashpoints}</span></div>
      <div class="pstat"><span class="k">Last sync</span><span class="v sync">${liveState.asOf?relTime(liveState.asOf):'—'}</span></div>
      <span class="live-pill ${st==='live'?'live':st==='partial'?'partial':st==='connecting'?'partial':'degraded'}" data-testid="live-pill"><span class="dot"></span>${liveLabel()}</span>
    </div>
    <div class="src-health">${health}${bundledChip}</div>`;
  const pc=$('#postureClock'); if(pc){ const d=new Date(); pc.textContent=d.toUTCString().slice(17,25)+'Z'; }
  refreshIcons();
}

/* Live event ticker */
function updateTicker(){
  const host=$('#cmdTicker'); if(!host) return;
  const evs=liveState.events;
  const sevDot={critical:'var(--sev-critical)',high:'var(--sev-high)',moderate:'var(--sev-moderate)',stable:'var(--sev-stable)'};
  const head=`
    <div class="ticker-h">
      <div class="tt"><span class="ld"></span>${liveState.status==='degraded'?'FEED DEGRADED':'INCOMING'}</div>
      <div class="t-ctrl">
        <button class="btn sm" id="tickPause">${icon(liveState.paused?'play':'pause')} ${liveState.paused?'Resume':'Pause'}</button>
        <button class="btn sm" id="tickJump">${icon('newspaper')} Intel</button>
      </div>
    </div>`;
  let body;
  if(liveState.status==='connecting'){ body=`<div class="ticker-item"><span class="ti-sev" style="background:var(--sev-moderate)"></span><div class="ti-main"><div class="ti-t">Connecting to live crisis feeds…</div></div></div>`; }
  else if(!evs.length){ body=`<div class="ticker-item"><span class="ti-sev" style="background:var(--cyan)"></span><div class="ti-main"><div class="ti-t">Live feeds unavailable — bundled intelligence remains fully operational.</div><div class="ti-s">Switch to Intel for ${D.INTEL_CARDS.length} curated items</div></div></div>`; }
  else { body=evs.slice(0,14).map((e,i)=>`
      <div class="ticker-item" data-url="${esc(e.url||'')}">
        <span class="ti-sev" style="background:${sevDot[e.severity]||'var(--sev-neutral)'}"></span>
        <div class="ti-main"><div class="ti-t">${esc(e.title)}</div><div class="ti-s">${esc(e.geography||'')} · ${esc(e.category||'')} · ${relTime(e.published)}</div></div>
        <span class="ti-src">${esc(e.source||'')}</span>
      </div>`).join(''); }
  host.innerHTML=head+`<div class="ticker-list">${body}</div>`;
  host.classList.toggle('paused',liveState.paused);
  $('#tickPause').addEventListener('click',()=>{ liveState.paused=!liveState.paused; updateTicker(); });
  $('#tickJump').addEventListener('click',()=>activateMode('intel'));
  $$('#cmdTicker .ticker-item[data-url]').forEach(node=>{
    const url=node.dataset.url;
    if(url) node.addEventListener('click',()=>window.open(url,'_blank','noopener'));
  });
  refreshIcons();
}

/* ================= GEOSPATIAL THEATER ================= */
function renderTheater(p){
  if(window.THEATER && window.THEATER.render){ window.THEATER.render(p); return; }
  p.innerHTML=`<div class="mode-head"><div class="eyebrow">Global Agricultural Intelligence Theater</div>
    <h2>Theater <em>unavailable</em></h2>
    <p class="lede">The geospatial theater modules failed to load. All bundled intelligence remains available in the Command, Map, Intel, Strategy and War Room modes.</p></div>`;
}

/* ================= MAP ================= */
let mapObj=null, mapLayerGroup=null, liveLayerGroup=null, activeLayer='food', wheelOn=false, liveOverlayOn=false;
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
      <button class="btn sm" id="wheelToggle" data-testid="wheel-toggle">${icon('mouse-pointer-2')} Wheel-zoom: OFF</button>
      <button class="btn sm" id="liveToggle" data-testid="live-toggle">${icon('radio')} Live events: OFF</button>
      <button class="btn sm" id="compareBtn" data-testid="compare-btn">${icon('git-compare')} Compare countries</button>
      <span class="chip">Click any marker for a country profile + sources</span>
    </div>
    <div class="panel pad0" style="border-radius:var(--radius)"><div id="map" role="application" aria-label="World crisis map"></div></div>
    <div id="compareTray"></div>
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
  $('#liveToggle').addEventListener('click',()=>{
    liveOverlayOn=!liveOverlayOn;
    $('#liveToggle').innerHTML=`${icon('radio')} Live events: ${liveOverlayOn?'ON':'OFF'}`;
    updateLiveOverlay(); refreshIcons();
  });
  $('#compareBtn').addEventListener('click',()=>openCompare());
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
  liveLayerGroup=L.layerGroup().addTo(mapObj);
  drawMarkers();
  updateLiveOverlay();
  setTimeout(()=>mapObj.invalidateSize(),120);
}
function drawMarkers(){
  if(!mapObj) return;
  mapLayerGroup.clearLayers();
  const layer=LAYERS.find(l=>l.id===activeLayer);
  const cc=(window.RendererTheme?RendererTheme.severityMap():{critical:'#e2483d',high:'#e8913c',moderate:'#d9b23a',stable:'#5ba86f'});
  D.COUNTRIES.forEach(c=>{
    const val=layer.metric(c), tl=layer.color(c);
    const r=6+Math.round(val/8);
    // restrained radar pulse for critical markers
    if(tl==='critical' && !REDUCED){
      const ring=L.circleMarker([c.lat,c.lng],{radius:r,color:cc.critical,weight:1.5,fill:false,opacity:.5,className:'pulse-ring'});
      ring.on('add',()=>{ const elp=ring.getElement(); if(elp){ elp.style.transformOrigin='center'; elp.animate([{opacity:.5,transform:'scale(1)'},{opacity:0,transform:'scale(2.4)'}],{duration:2400,iterations:Infinity,easing:'ease-out'}); } });
      mapLayerGroup.addLayer(ring);
    }
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

/* Live-event overlay on the map */
function updateLiveOverlay(){
  if(!mapObj||!liveLayerGroup) return;
  liveLayerGroup.clearLayers();
  if(!liveOverlayOn) return;
  const cc=(window.RendererTheme?RendererTheme.severityMap():{critical:'#e2483d',high:'#e8913c',moderate:'#d9b23a',stable:'#5ba86f'});
  liveState.events.filter(e=>typeof e.lat==='number'&&typeof e.lng==='number').forEach(e=>{
    const m=L.circleMarker([e.lat,e.lng],{radius:5,color:'#fff',weight:1,fillColor:cc[e.severity]||'#7d8794',fillOpacity:.9});
    m.bindPopup(`<b>${esc(e.title)}</b><br><span class="popup-src">${esc(e.source||'')} · ${esc(e.category||'')} · ${esc(relTime(e.published))}</span><br><a href="${esc(e.url||'#')}" target="_blank" rel="noopener">Open source →</a>`);
    liveLayerGroup.addLayer(m);
  });
}

/* Two-country compare mode */
let compareSel=[];
function openCompare(){
  const tray=$('#compareTray'); if(!tray) return;
  if(!compareSel.length) compareSel=[D.COUNTRIES.find(c=>c.tl==='critical')?.code||D.COUNTRIES[0].code, D.COUNTRIES.filter(c=>c.tl==='critical')[1]?.code||D.COUNTRIES[1].code];
  drawCompare();
  tray.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function drawCompare(){
  const tray=$('#compareTray'); if(!tray) return;
  const opts=code=>D.COUNTRIES.map(c=>`<option value="${c.code}" ${c.code===code?'selected':''}>${c.flag} ${esc(c.name)}</option>`).join('');
  const a=D.COUNTRIES.find(c=>c.code===compareSel[0]), b=D.COUNTRIES.find(c=>c.code===compareSel[1]);
  const metrics=[['Food-insecure %','hungerPct'],['Conflict','conflict'],['Climate','climate'],['Water stress','water'],['Production','production']];
  const col=(c,other)=>`
    <div class="compare-col">
      <h4>${c.flag} ${esc(c.name)} ${badge(c.tl)}</h4>
      ${metrics.map(([lbl,key])=>{const v=c[key],ov=other[key],hi=v>ov;return `<div class="cmp-metric"><div class="cm-h"><span>${lbl}</span><span class="v" style="color:${hi?'var(--sev-critical)':'var(--text-dim)'}">${v}</span></div><div class="track"><div class="fill" style="width:${Math.min(100,v)}%;background:var(--sev-${c.tl})"></div></div></div>`;}).join('')}
    </div>`;
  const worse = (a.hungerPct+a.conflict+a.climate) >= (b.hungerPct+b.conflict+b.climate) ? a : b;
  tray.innerHTML=`
    <div class="compare-tray" data-testid="compare-tray">
      <div class="btn-row" style="margin-bottom:14px">
        <select class="select" id="cmpA">${opts(compareSel[0])}</select>
        <span class="chip">vs</span>
        <select class="select" id="cmpB">${opts(compareSel[1])}</select>
        <button class="btn sm" id="cmpClose" style="margin-left:auto">${icon('x')} Close</button>
      </div>
      <div class="compare-grid">
        ${col(a,b)}
        <div class="compare-vs">VS</div>
        ${col(b,a)}
      </div>
      <div class="panel" style="margin-top:14px">
        <p style="margin:0;font-size:13px;color:var(--text-dim)"><strong style="color:var(--text)">Suggested intervention:</strong> ${esc(worse.name)} carries the higher composite stress. ${worse.water>=70?'Water stress dominates — lead with Regenerative Biology (water-retention wedge).':worse.conflict>=70?'Conflict dominates — Coordination Layer routes around contested corridors while Clinical Intelligence triages acute need.':'Lead with Clinical Intelligence for acute food-security triage, backed by Coordination Layer distribution.'}</p>
        <div class="btn-row" style="margin-top:10px"><button class="btn sm primary" id="cmpAtom">${icon('sparkles')} Ask ATOM to compare</button></div>
      </div>
    </div>`;
  $('#cmpA').addEventListener('change',e=>{compareSel[0]=e.target.value;drawCompare();});
  $('#cmpB').addEventListener('change',e=>{compareSel[1]=e.target.value;drawCompare();});
  $('#cmpClose').addEventListener('click',()=>{$('#compareTray').innerHTML='';});
  $('#cmpAtom').addEventListener('click',()=>openAtom('Compare the agricultural crisis in '+a.name+' vs '+b.name+' across food security, conflict, climate and water. Which should Nirmata prioritize and with which pillar? Give confidence and sources.'));
  refreshIcons();
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

    <div class="panel" id="liveWire" data-testid="live-wire" style="margin-bottom:20px"></div>

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
  mergeLiveIntel();
  drawIntel();
}
function mergeLiveIntel(){
  const host=$('#liveWire'); if(!host) return;
  const st=liveState.status;
  const sevDot={critical:'var(--sev-critical)',high:'var(--sev-high)',moderate:'var(--sev-moderate)',stable:'var(--sev-stable)'};
  const pill=`<span class="live-pill ${st==='live'?'live':st==='partial'?'partial':st==='connecting'?'partial':'degraded'}" style="margin-left:auto"><span class="dot"></span>${liveLabel()}</span>`;
  let inner;
  if(st==='degraded'||(!liveState.events.length&&st!=='connecting')){
    inner=`<p class="muted" style="margin:0;font-size:13px">Live wire unavailable — showing bundled intelligence only. All ${D.INTEL_CARDS.length} curated items below remain fully current as of ${D.AS_OF}.</p>`;
  } else if(st==='connecting'){
    inner=`<p class="muted" style="margin:0;font-size:13px">Connecting to live crisis feeds…</p>`;
  } else {
    inner=`<div class="rows">${liveState.events.slice(0,6).map(e=>`
      <div class="row-item" data-url="${esc(e.url||'')}" role="button" tabindex="0">
        <span class="ti-sev" style="width:9px;height:9px;border-radius:50%;background:${sevDot[e.severity]||'var(--sev-neutral)'};flex:0 0 auto"></span>
        <div class="ri-main"><div class="t" style="white-space:normal">${esc(e.title)}</div><div class="s">${esc(e.source||'')} · ${esc(e.geography||'')} · ${relTime(e.published)}</div></div>
        <div class="ri-end"><span class="chip">${esc(e.category||'live')}</span></div>
      </div>`).join('')}</div>`;
  }
  host.innerHTML=`<div class="panel-h"><h4>${icon('radio')} Live wire <span class="mono muted" style="font-size:11px">· public feeds</span></h4>${pill}</div>${inner}`;
  $$('#liveWire .row-item[data-url]').forEach(node=>{
    const url=node.dataset.url;
    const go=()=>{ if(url) window.open(url,'_blank','noopener'); };
    node.addEventListener('click',go);
    node.addEventListener('keydown',e=>{if(e.key==='Enter')go();});
  });
  refreshIcons();
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
let strategyChart=null, currentFrame='questions', matrixFilter={pillar:'all',horizon:'all'};
function filteredMatrix(){
  return D.OPP_MATRIX.filter(o=>
    (matrixFilter.pillar==='all'||o.pillar===matrixFilter.pillar)&&
    (matrixFilter.horizon==='all'||o.horizon===matrixFilter.horizon));
}
function drawMatrix(){
  const tb=$('#matrixTable tbody'); if(!tb) return;
  const priBadge={critical:'critical',high:'high',strategic:'moderate',medium:'neutral'};
  const rows=filteredMatrix();
  tb.innerHTML=rows.length?rows.map(o=>`
    <tr data-opp="${esc(o.opp)}" style="cursor:pointer"><td><strong>${esc(o.opp)}</strong><div class="sub">${esc(o.sub)}</div></td>
    <td>${badge(priBadge[o.pri]||'neutral')}</td>
    <td class="mono" style="font-size:12px">${esc(o.size)}</td>
    <td class="mono">${o.conf}%</td>
    <td class="mono" style="font-size:12px">${esc(o.time)}</td></tr>`).join('')
    :`<tr><td colspan="5" class="muted" style="text-align:center;padding:20px">No opportunities match this filter.</td></tr>`;
  $$('#matrixTable tbody tr[data-opp]').forEach(r=>r.addEventListener('click',()=>{
    const o=D.OPP_MATRIX.find(x=>x.opp===r.dataset.opp);
    if(o) openAtom('Brief me on the "'+o.opp+'" opportunity for Nirmata ('+o.sub+'). Market size '+o.size+'. Give a go/no-go with confidence and 3 sources.');
  }));
}
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
      <div class="mx-filters" id="mxFilters" data-testid="matrix-filters"></div>
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

  // matrix filters + table
  const pillarNames={all:'All pillars',bio:'Regenerative Biology',coord:'Coordination',infra:'Secure Infra',clin:'Clinical'};
  const horizonNames={all:'All horizons',near:'Near',mid:'Mid',long:'Long'};
  $('#mxFilters').innerHTML=
    Object.keys(pillarNames).map(k=>`<button class="fbtn ${k==='all'?'active':''}" data-kind="pillar" data-v="${k}">${pillarNames[k]}</button>`).join('')+
    `<span style="width:1px;background:var(--border);margin:0 4px"></span>`+
    Object.keys(horizonNames).map(k=>`<button class="fbtn ${k==='all'?'active':''}" data-kind="horizon" data-v="${k}">${horizonNames[k]}</button>`).join('');
  $$('#mxFilters .fbtn').forEach(b=>b.addEventListener('click',()=>{
    const kind=b.dataset.kind;
    $$(`#mxFilters .fbtn[data-kind="${kind}"]`).forEach(x=>x.classList.toggle('active',x===b));
    matrixFilter[kind]=b.dataset.v; drawMatrix();
  }));
  drawMatrix();
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

/* ================= SIMULATE / WAR ROOM 2.0 ================= */
let simSel={pillar:null,threat:null}, simIntensity=3, simHorizon='mid';
let lastSimResult=null; // snapshot of the most recent resolved engagement (for Save Scenario)
const HORIZON_MOD={near:-4,mid:0,long:6}; // longer horizon lets structural pillars compound
function renderSimulate(p){
  p.innerHTML=`
    <div class="mode-head">
      <div class="eyebrow">War Room · Threat Simulation &amp; Intervention</div>
      <h2>Pillar <em>vs</em> threat</h2>
      <p class="lede">Select one Nirmata pillar and one systemic threat, tune intensity and horizon, and model the engagement: an animated sequence, before/after risk vectors, three courses of action, and residual risk — all deterministic and explainable.</p>
    </div>
    <div class="war-params" data-testid="war-params">
      <div class="war-param"><label>Threat intensity <span class="pv" id="intVal">3 / 5</span></label><input type="range" id="simInt" min="1" max="5" value="3" data-testid="sim-intensity"/></div>
      <div class="war-param"><label>Response horizon</label><select id="simHor" data-testid="sim-horizon"><option value="near">Near — 2026 (acute)</option><option value="mid" selected>Mid — 2027–2029</option><option value="long">Long — 2030+</option></select></div>
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
      <div class="section-title"><h3>${icon('crosshair')} Engagement outcome</h3>
        <div class="btn-row"><button class="btn sm" id="simRestart">${icon('rotate-ccw')} Reset</button><button class="btn sm" id="simSave" data-testid="sim-save" disabled>${icon('save')} Save scenario</button><button class="btn sm primary" id="simAtom">${icon('sparkles')} Ask ATOM to war-game</button></div>
      </div>
      <div class="sim-console" id="simConsole"></div>
      <div id="simExtra"></div>
    </div>
    <div class="section" id="scenarioHistorySection" data-testid="scenario-history-section" hidden>
      <div class="section-title"><h3>${icon('history')} Saved scenarios</h3><span class="meta" id="scenarioHistoryMeta">team-scoped · replayable</span></div>
      <div id="scenarioHistory"></div>
    </div>`;
  $('#simPillars').innerHTML=D.SIM_PILLARS.map(pl=>`
    <button class="move-card pillar-c" data-id="${pl.id}" data-testid="sim-pillar-${pl.id}"><div class="mi">${pl.short}</div><div><div class="mt">${esc(pl.name)}</div><div class="md">${esc(pl.desc)}</div></div></button>`).join('');
  $('#simThreats').innerHTML=D.SIM_THREATS.map(t=>`
    <button class="move-card threat" data-id="${t.id}" data-testid="sim-threat-${t.id}"><div class="mi">${t.short}</div><div><div class="mt">${esc(t.name)}</div><div class="md">${badge(t.sev)}</div></div></button>`).join('');
  $$('#simPillars .move-card').forEach(b=>b.addEventListener('click',()=>{simSel.pillar=b.dataset.id;$$('#simPillars .move-card').forEach(x=>x.classList.toggle('selected',x===b));resolveSim();}));
  $$('#simThreats .move-card').forEach(b=>b.addEventListener('click',()=>{simSel.threat=b.dataset.id;$$('#simThreats .move-card').forEach(x=>x.classList.toggle('selected',x===b));resolveSim();}));
  $('#simInt').addEventListener('input',e=>{simIntensity=+e.target.value;$('#intVal').textContent=simIntensity+' / 5';resolveSim();});
  $('#simHor').addEventListener('change',e=>{simHorizon=e.target.value;resolveSim();});
  $('#simRestart').addEventListener('click',()=>{simSel={pillar:null,threat:null};$$('.move-card').forEach(x=>x.classList.remove('selected'));resolveSim();});
  $('#simAtom').addEventListener('click',()=>{
    const pn=simSel.pillar?D.SIM_PILLARS.find(x=>x.id===simSel.pillar).name:'a Nirmata pillar';
    const tn=simSel.threat?D.SIM_THREATS.find(x=>x.id===simSel.threat).name:'a systemic threat';
    openAtom('War-game deploying '+pn+' against '+tn+' at intensity '+simIntensity+'/5 over a '+simHorizon+' horizon. Compare three courses of action with effectiveness, residual risk, trade-offs and a recommendation.');
  });
  const saveBtn=$('#simSave');
  if(saveBtn) saveBtn.addEventListener('click',()=>{ if(window.AGRI_COLLAB) window.AGRI_COLLAB.saveScenario(); });
  resolveSim();
  if(window.AGRI_COLLAB) window.AGRI_COLLAB.onSimRendered();
}
// deterministic effectiveness: base pairing ± intensity penalty ± horizon mod, clamped
function simEff(pillar,threat,intensity,horizon,coaMod){
  const o=D.SIM_OUTCOMES[pillar+'_'+threat];
  const base=o?o.eff:50;
  const intPenalty=(intensity-3)*4; // higher intensity slightly lowers effectiveness
  let e=base - intPenalty + HORIZON_MOD[horizon] + (coaMod||0);
  return Math.max(5,Math.min(97,Math.round(e)));
}
function presetSim(owner){
  const map={INF:'infra',COO:'coord',BIO:'bio',CLI:'clin'};
  const pid=map[owner]; if(!pid) return;
  simSel.pillar=pid;
  if(!simSel.threat) simSel.threat = pid==='bio'?'aquifer':pid==='clin'?'blackswan':pid==='infra'?'cyber':'farmpec';
  $$('#simPillars .move-card').forEach(x=>x.classList.toggle('selected',x.dataset.id===pid));
  $$('#simThreats .move-card').forEach(x=>x.classList.toggle('selected',x.dataset.id===simSel.threat));
  resolveSim();
}
function resolveSim(){
  const c=$('#simConsole'), extra=$('#simExtra'); if(!c)return;
  if(!simSel.pillar||!simSel.threat){
    c.innerHTML=`<div class="outcome muted">${icon('mouse-pointer-click','ic')}  Select one pillar and one threat to model an engagement.\n\nAdjust intensity and horizon to see the effectiveness, engagement sequence, before/after vectors and three courses of action update deterministically.</div>`;
    if(extra) extra.innerHTML=''; lastSimResult=null;
    const sb0=$('#simSave'); if(sb0) sb0.disabled=true;
    if(window.AGRI_COLLAB) window.AGRI_COLLAB.onSimResolved();
    refreshIcons(); return;
  }
  const pillar=simSel.pillar, threat=simSel.threat;
  const o=D.SIM_OUTCOMES[pillar+'_'+threat];
  const pn=D.SIM_PILLARS.find(x=>x.id===pillar).name, tn=D.SIM_THREATS.find(x=>x.id===threat).name;
  const eff=simEff(pillar,threat,simIntensity,simHorizon,0), line=o?o.line:'Model pending for this pairing.';
  const rating=eff>=75?'Decisive':eff>=55?'Strong':eff>=40?'Partial':'Weak';
  const col=eff>=75?'var(--sev-stable)':eff>=55?'var(--cyan)':eff>=40?'var(--sev-moderate)':'var(--sev-critical)';
  c.innerHTML=`
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <span class="chip cyan">${esc(pn)}</span>${icon('arrow-right','ic')}<span class="chip">${esc(tn)}</span>
      <span class="chip">intensity ${simIntensity}/5</span><span class="chip">${simHorizon} horizon</span>
      <span class="badge ${eff>=55?'stable':eff>=40?'moderate':'critical'}" style="margin-left:auto" data-testid="sim-rating"><span class="d"></span>${rating} · ${eff}%</span>
    </div>
    <div class="gauge"><span class="mono" style="font-size:11px;color:var(--muted)">EFFECT</span><div class="track"><div class="fill" style="width:${eff}%;background:${col};transition:width .8s ease"></div></div></div>
    <div class="engage-seq" id="engageSeq"></div>`;
  // animated engagement sequence
  const seq=[
    `<span class="tag">[T+0]</span> ${esc(pn)} deployed against ${esc(tn)} at intensity ${simIntensity}/5.`,
    `<span class="tag">[T+1]</span> ${esc((line.split('. ')[0]||line))}.`,
    `<span class="tag">[T+2]</span> Effectiveness resolves to ${eff}% (${rating}); residual risk ${100-eff}%.`,
    `<span class="tag">[T+3]</span> Recommend complementary pillar to close the gap.`,
  ];
  const seqHost=$('#engageSeq');
  seq.forEach((s,i)=>{ const d=el('div','es-line',s); d.style.animationDelay=(REDUCED?0:i*0.28)+'s'; seqHost.appendChild(d); });

  // before/after risk vectors (deterministic: threat raises baseline, pillar reduces by eff share)
  const baseVec={'Food security':62,'Supply resilience':55,'Water margin':48,'Coordination':44};
  const after={};
  Object.keys(baseVec).forEach(k=>{ const before=Math.min(95,baseVec[k]+simIntensity*4); after[k]=Math.max(8,Math.round(before-(before*eff/140))); });
  // 3 COA cards
  const coas=(D.COA_LIB[pillar]||[]).map(co=>({...co,eff:simEff(pillar,threat,simIntensity,simHorizon,co.effMod)}));
  const bestEff=Math.max(...coas.map(c=>c.eff));
  extra.innerHTML=`
    <div class="beforeafter" data-testid="beforeafter">
      <div class="ba-col"><h5>${icon('trending-up')} Before intervention</h5>${Object.keys(baseVec).map(k=>{const v=Math.min(95,baseVec[k]+simIntensity*4);return `<div class="ba-metric"><div class="bm-h"><span>${k}</span><span class="v">${v}</span></div><div class="track"><div class="fill" style="width:${v}%;background:var(--sev-high)"></div></div></div>`;}).join('')}</div>
      <div class="ba-col"><h5>${icon('trending-down')} After ${esc(pn)}</h5>${Object.keys(after).map(k=>`<div class="ba-metric"><div class="bm-h"><span>${k}</span><span class="v">${after[k]}</span></div><div class="track"><div class="fill" style="width:${after[k]}%;background:var(--sev-stable);transition:width .8s ease"></div></div></div>`).join('')}</div>
    </div>
    <div class="section-title" style="margin-top:18px"><h3>${icon('swords')} Courses of action</h3><span class="meta">deterministic · pick a tempo</span></div>
    <div class="coa-cards" data-testid="coa-cards">
      ${coas.map(co=>`<div class="coa-card ${co.eff===bestEff?'best':''}">
        <div class="cc-head"><div><div class="cc-name">${esc(co.name)}</div><div class="cc-tempo">${esc(co.tempo)}</div></div><div class="cc-eff" style="color:${co.eff>=75?'var(--sev-stable)':co.eff>=55?'var(--cyan)':co.eff>=40?'var(--sev-moderate)':'var(--sev-critical)'}">${co.eff}%</div></div>
        <div class="cc-desc">${esc(co.desc)}</div>
        <div class="cc-pc"><b>+</b> ${co.pros.map(esc).join(', ')}</div>
        <div class="cc-pc"><i>−</i> ${co.cons.map(esc).join(', ')}</div>
        <div class="cc-pc mono">Residual ${100-co.eff}%</div>
      </div>`).join('')}
    </div>
    <p class="muted" style="font-size:11px;margin-top:12px;font-family:var(--mono)">Effectiveness = base pairing model ± intensity penalty ± horizon modifier ± COA modifier, clamped 5–97%. Deterministic — no randomness. Recommended COA: <strong style="color:var(--text)">${esc(coas.find(c=>c.eff===bestEff).name)}</strong>.</p>`;
  // snapshot for Save Scenario (persistence)
  lastSimResult={
    title:pn+' vs '+tn,
    threat:tn, pillar:pn,
    params:{pillarId:pillar,threatId:threat,intensity:simIntensity,horizon:simHorizon},
    result:{effectiveness:eff,rating:rating,residual:100-eff,
      recommendedCoa:coas.find(c=>c.eff===bestEff).name,
      coas:coas.map(co=>({name:co.name,eff:co.eff,tempo:co.tempo})),
      before:Object.keys(baseVec).reduce((a,k)=>{a[k]=Math.min(95,baseVec[k]+simIntensity*4);return a;},{}),
      after:after}
  };
  const sb=$('#simSave'); if(sb) sb.disabled=false;
  if(window.AGRI_COLLAB) window.AGRI_COLLAB.onSimResolved();
  refreshIcons();
}

/* ================= RESOURCES / DATA ================= */
const RES_TABS=[
  {id:'feeds',label:'Live Feeds'},
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
    if(currentResTab==='feeds') drawSourceHealth(); else drawResourceCharts(currentResTab);
  }));
  // build all sub-panels (static content is cheap; charts drawn lazily)
  drawSourceHealth(); buildResMarkets(); buildResWater(); buildResSoil(); buildResAI();
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
    <div class="section-title"><h3>${icon('network')} Correlated-industry dependency web</h3><span class="meta">click a node to trace dependencies · 0–100</span></div>
    <div class="cards industry-web" id="industryWeb">${D.INDUSTRIES.map(i=>`
      <div class="card" data-t="${esc(i.t)}"><div class="ch"><h4>${esc(i.t)}</h4><span class="mono muted">${i.dep}</span></div>
      <div class="track"><div class="fill" style="width:${i.dep}%;background:var(--cyan)"></div></div>
      <p>${esc(i.d)}</p>
      ${Array.isArray(i.links)?`<div class="links">${i.links.map(l=>`<span class="chip">${esc(l)}</span>`).join('')}</div>`:''}</div>`).join('')}</div>`;
  let webSel=null;
  $$('#industryWeb .card').forEach(card=>card.addEventListener('click',()=>{
    const t=card.dataset.t, ind=D.INDUSTRIES.find(x=>x.t===t);
    if(webSel===t){ webSel=null; $$('#industryWeb .card').forEach(c=>c.classList.remove('linked','faded')); return; }
    webSel=t;
    const linked=new Set([t,...(ind.links||[])]);
    $$('#industryWeb .card').forEach(c=>{ const ct=c.dataset.t; c.classList.toggle('linked',linked.has(ct)); c.classList.toggle('faded',!linked.has(ct)); });
  }));
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
  const RT=window.RendererTheme;
  const gridCol=RT?RT.grid():'rgba(255,255,255,.06)';
  const axisCol=RT?RT.axisLabel():'#8b877d';
  const axis={grid:{color:gridCol},ticks:{color:axisCol,font:{size:11}}};
  const legendOpt={labels:{color:axisCol,font:{size:11},boxWidth:12}};
  if(tab==='markets'&&!resCharts.prices&&$('#chartPrices')){
    const cols=RT?RT.commodity():{wheat:'#e2483d',rice:'#5fb3c4',maize:'#e8913c',soy:'#5ba86f',coffee:'#bf8f5f',cocoa:'#d9b23a'};
    resCharts.prices=new Chart($('#chartPrices'),{type:'line',
      data:{labels:D.MONTHS_24,datasets:Object.keys(D.COMMODITY_PRICES).map(k=>{const s=D.COMMODITY_PRICES[k],b=s[0];return {label:k,data:s.map(v=>Math.round(v/b*1000)/10),borderColor:cols[k],backgroundColor:'transparent',borderWidth:2,pointRadius:0,tension:.3};})},
      options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:legendOpt,tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.parsed.y} (base 100 = ${D.MONTHS_24[0]})`}}},scales:{x:axis,y:{...axis,title:{display:true,text:'Index (base 100)',color:'#8b877d',font:{size:11}}}}}});
  }
  if(tab==='water'&&!resCharts.aquifer&&$('#chartAquifer')){
    const aq=[...D.AQUIFERS].sort((a,b)=>b.depletion-a.depletion);
    resCharts.aquifer=new Chart($('#chartAquifer'),{type:'bar',
      data:{labels:aq.map(a=>a.name),datasets:[{label:'Depletion %',data:aq.map(a=>a.depletion),backgroundColor:aq.map(a=>RT?RT.severity(a.tl):({critical:'#e2483d',high:'#e8913c',moderate:'#d9b23a'}[a.tl]||'#5ba86f'))}]},
      options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{afterLabel:ctx=>'~'+aq[ctx.dataIndex].years+' yr to critical'}}},scales:{x:{...axis,max:100},y:{...axis,ticks:{color:'#b4afa4',font:{size:10}}}}}});
  }
  if(tab==='ai'&&!resCharts.ai&&$('#chartAI')){
    resCharts.ai=new Chart($('#chartAI'),{type:'radar',
      data:{labels:D.AI_GAPS.map(g=>g.name),datasets:[
        {label:'Urgency',data:D.AI_GAPS.map(g=>g.urgency),borderColor:RT?RT.danger():'#e2483d',backgroundColor:RT?RT.danger(0.15):'rgba(226,72,61,.15)',borderWidth:2,pointRadius:2},
        {label:'Solution maturity',data:D.AI_GAPS.map(g=>g.maturity),borderColor:RT?RT.accent():'#5fb3c4',backgroundColor:RT?RT.accent(0.12):'rgba(95,179,196,.12)',borderWidth:2,pointRadius:2}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:legendOpt},scales:{r:{angleLines:{color:'rgba(255,255,255,.08)'},grid:{color:'rgba(255,255,255,.08)'},pointLabels:{color:'#b4afa4',font:{size:10}},ticks:{color:'#5f5c55',backdropColor:'transparent'},min:0,max:100}}}});
  }
  if(tab==='chain'&&!resCharts.token&&$('#chartToken')){
    resCharts.token=new Chart($('#chartToken'),{type:'line',
      data:{labels:D.TOKEN_TRAJ.years,datasets:[{label:'Tokenized agri market ($B)',data:D.TOKEN_TRAJ.vals,borderColor:RT?RT.accent():'#5fb3c4',backgroundColor:RT?RT.accent(0.14):'rgba(95,179,196,.14)',borderWidth:2,fill:true,tension:.35,pointRadius:3}]},
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
  $('#atomPresets').innerHTML=D.ATOM_PRESETS.map(p=>`<button class="atom-preset" data-p="${p.id}">${icon(p.icon)}${esc(p.label)}</button>`).join('');
  $$('#atomPresets .atom-preset').forEach(b=>b.addEventListener('click',()=>{const p=D.ATOM_PRESETS.find(x=>x.id===b.dataset.p);if(p)sendAtom(p.prompt);}));
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
    b.innerHTML=atomHistory.map((m,i)=>{
      let inner;
      if(m.pending) inner='<span class="spinner"></span> '+esc(m.stage||'analyzing…');
      else if(m.role==='assistant'&&m.ui) inner=renderAtomUI(m.ui,i);
      else inner=esc(m.content);
      const note=(m.role==='assistant'&&m.actionNote)?`<div class="au-block au-gen">${icon('zap')} ${esc(m.actionNote)} · view in Theater</div>`:'';
      return `<div class="atom-msg ${m.role}"><div class="who">${m.role==='user'?'You':'ATOM'}</div><div class="bubble">${note}${inner}</div></div>`;
    }).join('');
    // wire follow-up chips
    $$('#atomBody .au-followups button').forEach(btn=>btn.addEventListener('click',()=>sendAtom(btn.dataset.q)));
    $$('#atomBody .au-actions .btn').forEach(btn=>btn.addEventListener('click',()=>{
      const act=btn.dataset.act;
      if(act==='map'){ closeAtom(); activateMode('map'); }
      else if(act==='wargame'){ closeAtom(); activateMode('simulate'); }
      else if(act==='intel'){ closeAtom(); activateMode('intel'); }
    }));
    b.scrollTop=b.scrollHeight;
    refreshIcons();
  }
}
// Parse a fenced ```atom-ui JSON block out of ATOM's text; returns {ui, text} or null
function parseAtomUI(content){
  const m=content.match(/```atom-ui\s*([\s\S]*?)```/);
  if(!m) return null;
  try{
    const ui=JSON.parse(m[1].trim());
    const text=content.replace(m[0],'').trim();
    return {ui,text};
  }catch(e){ return null; }
}
function renderAtomUI(ui,idx){
  const blocks=[];
  const clampN=v=>Math.max(0,Math.min(100,parseInt(v,10)||0));
  if(ui.lede||ui.brief){ blocks.push(`<div class="au-block au-brief"><div class="au-h">${icon('file-text')} Executive brief</div><p>${esc(ui.lede||ui.brief)}</p>${Array.isArray(ui.keypoints)?`<ul>${ui.keypoints.map(k=>`<li>${esc(k)}</li>`).join('')}</ul>`:''}</div>`); }
  if(Array.isArray(ui.threats)&&ui.threats.length){ blocks.push(`<div class="au-block"><div class="au-h">${icon('alert-triangle')} Threat cards</div><div class="au-threats">${ui.threats.map(t=>`<div class="au-threat ${['critical','high','moderate'].includes(t.severity)?t.severity:'moderate'}"><div class="th-t">${esc(t.title||'')}</div>${t.detail?`<div class="th-d">${esc(t.detail)}</div>`:''}</div>`).join('')}</div></div>`); }
  if(Array.isArray(ui.coas)&&ui.coas.length){ const best=Math.max(...ui.coas.map(c=>clampN(c.eff))); blocks.push(`<div class="au-block"><div class="au-h">${icon('swords')} Courses of action</div><div class="au-coa">${ui.coas.map(c=>`<div class="au-coa-card ${(c.recommended||clampN(c.eff)===best)?'rec':''}"><div class="cc-t">${esc(c.name||'')}<span class="cc-eff">${clampN(c.eff)}% · residual ${c.residual!=null?clampN(c.residual):100-clampN(c.eff)}%</span></div>${c.note?`<div class="cc-d">${esc(c.note)}</div>`:''}</div>`).join('')}</div></div>`); }
  if(ui.confidence!=null){ const cf=clampN(ui.confidence); const col=cf>=75?'var(--sev-stable)':cf>=55?'var(--cyan)':cf>=40?'var(--sev-moderate)':'var(--sev-critical)'; blocks.push(`<div class="au-block"><div class="au-h">${icon('gauge')} Confidence</div><div class="au-conf"><div class="track"><div class="fill" style="width:${cf}%;background:${col}"></div></div><span class="cval">${cf}%</span></div></div>`); }
  if(Array.isArray(ui.citations)&&ui.citations.length){ blocks.push(`<div class="au-block"><div class="au-h">${icon('link')} Citations</div><div class="au-cites">${ui.citations.map(c=>`<span class="au-cite">${esc(c)}</span>`).join('')}</div></div>`); }
  blocks.push(`<div class="au-block au-gen">${icon('sparkles')} Model-generated analysis via /api/atom · verify sourced claims independently</div>`);
  if(Array.isArray(ui.followups)&&ui.followups.length){ blocks.push(`<div class="au-followups">${ui.followups.map(f=>`<button data-q="${esc(f)}">${icon('corner-down-right')} ${esc(f)}</button>`).join('')}</div>`); }
  return `<div class="atom-ui">${blocks.join('')}</div>`;
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
async function sendAtom(prompt){
  const ta=$('#atomInput'); const q=(prompt!=null?String(prompt):ta.value).trim(); if(!q) return;
  if(!$('#atom').classList.contains('open')) openAtom();
  ta.value=''; ta.style.height='auto';
  atomHistory.push({role:'user',content:q});
  const pending={role:'assistant',content:'',pending:true,stage:'correlating intelligence…'}; atomHistory.push(pending);
  renderAtomBody(); $('#atomSend').disabled=true;
  // staged reveal cues while awaiting the server
  const stages=['correlating intelligence…','weighing pillar leverage…','scoring confidence…'];
  let si=0; const stageTimer=REDUCED?null:setInterval(()=>{ si=(si+1)%stages.length; if(pending.pending){ pending.stage=stages[si]; renderAtomBody(); } },1100);
  const ctx = `Modes available: Command/Map/Intel/Strategy/WarRoom/Data. As-of ${D.AS_OF}. Key figures: 295M acute food-insecure, 5 IPC-5 countries, FFPI 148.2, wheat stocks-to-use 26.4%, fertilizer +35%. Live feed status: ${liveState.status}.`;
  try{
    const res=await fetch('/api/atom',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({messages:atomHistory.filter(m=>!m.pending).map(m=>({role:m.role,content:m.content})),mode:atomMode,stream:false,context:ctx})});
    if(!res.ok){ throw new Error('HTTP '+res.status); }
    const data=await res.json();
    let content = data?.choices?.[0]?.message?.content || 'No content returned.';
    // Extract + execute allowlisted theater actions (validated schema; never arbitrary code).
    if(window.THEATER_ACTIONS && window.THEATER && window.THEATER.executeActions){
      const actx={ nodeIds:(window.THEATER_DATA&&window.THEATER_DATA.NODE_BY_ID)||null };
      const pa=window.THEATER_ACTIONS.parseAtomActions(content, actx);
      if(pa.actions.length||pa.rejected.length) content=pa.text||content;
      if(pa.actions.length){
        activateMode('theater');
        const acts=pa.actions.slice();
        setTimeout(()=>{ try{ window.THEATER.executeActions(acts); }catch(e){} },220);
        pending.actionNote=pa.actions.length+' theater action'+(pa.actions.length>1?'s':'')+' applied';
      }
    }
    const parsed=parseAtomUI(content);
    pending.pending=false;
    if(parsed){ pending.ui=parsed.ui; pending.content=parsed.text||content; }
    else pending.content=content;
  }catch(err){
    pending.pending=false;
    const code=/^HTTP (\d{3})$/.exec(String(err&&err.message));
    const hint=code?' (server returned '+code[1]+')':'';
    pending.content='⚠ ATOM is temporarily unavailable'+hint+'.\n\nThe live agent needs the PPLX_KEY environment variable configured on the server. All bundled intelligence in this command center remains fully available offline — try the Command, Intel, Strategy and War Room modes.';
  }
  if(stageTimer) clearInterval(stageTimer);
  renderAtomBody(); $('#atomSend').disabled=false; refreshIcons();
}

/* ================= COLLAB BRIDGE ================= */
/* Exposes the internals the collaboration layer (assets/collab.js) needs,
   without collab reaching into module-private scope. Kept intentionally small. */
window.AGRI_APP = {
  openDrawer, closeDrawer, openAtom, activateMode, refreshIcons,
  esc, icon, badge, el, reduced: REDUCED,
  // War Room integration
  getSimSnapshot: ()=> lastSimResult ? JSON.parse(JSON.stringify(lastSimResult)) : null,
  // Theater/Food-War sim writes its snapshot here so collab's Save Scenario can read it.
  setSimSnapshot: (snap)=>{ lastSimResult = snap || null; },
  applyScenario: (params)=>{
    if(!params) return;
    // Food War scenarios replay into the geospatial theater, not the classic War Room.
    if(params.type==='foodwar'){
      activateMode('theater');
      setTimeout(()=>{ if(window.THEATER&&window.THEATER.replay) window.THEATER.replay(params); },200);
      return;
    }
    activateMode('simulate');
    setTimeout(()=>{
      if(params.pillarId){ simSel.pillar=params.pillarId; }
      if(params.threatId){ simSel.threat=params.threatId; }
      if(params.intensity){ simIntensity=+params.intensity; const si=$('#simInt'); if(si){ si.value=simIntensity; } const iv=$('#intVal'); if(iv) iv.textContent=simIntensity+' / 5'; }
      if(params.horizon){ simHorizon=params.horizon; const sh=$('#simHor'); if(sh) sh.value=simHorizon; }
      $$('#simPillars .move-card').forEach(x=>x.classList.toggle('selected',x.dataset.id===simSel.pillar));
      $$('#simThreats .move-card').forEach(x=>x.classList.toggle('selected',x.dataset.id===simSel.threat));
      resolveSim();
      const host=$('#simConsole'); if(host) host.scrollIntoView({behavior:'smooth',block:'nearest'});
    },180);
  },
  // War Room threat/pillar catalogs for the New-mission composer + labels
  pillars: (window.AGRI && window.AGRI.PILLARS) ? window.AGRI.PILLARS.map(p=>p.name) : [],
  // Live fused-intel snapshot for the Theater/GenUI consumers (read-only copy).
  getIntel: ()=> ({ status:intelData.status, asOf:intelData.asOf, bundled:intelData.bundled,
    summary:intelData.summary, sources:intelData.sources.slice(), events:intelData.events.slice() }),
  refreshIntel: ()=> pollIntel(),
  trafficFor, evidenceBadge, signalBubble, trafficLegend,
};

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
  w.document.write(`<html><head><title>AgriOS Daily Brief ${D.AS_OF}</title>
    <style>body{font-family:Georgia,serif;max-width:720px;margin:32px auto;color:#111;line-height:1.55;padding:0 20px}
    h1{font-size:22px;border-bottom:3px solid #e2483d;padding-bottom:8px}h2{font-size:14px;color:#e2483d;margin-top:22px;text-transform:uppercase;letter-spacing:.05em}
    .kpis{display:flex;flex-wrap:wrap;gap:14px;margin:14px 0}.kpi{border:1px solid #ccc;border-radius:6px;padding:8px 12px;font-size:13px}.kpi b{font-size:18px;display:block}
    li{margin:5px 0;font-size:13px}small{color:#666}</style></head><body>
    <h1>AgriOS · A Nirmata Holdings Company — Daily Intelligence Brief</h1>
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
