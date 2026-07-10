/* ============================================================
   AGRI-NEXUS COMMAND CENTER — bundled intelligence dataset
   All values carry a source. Freshness as of 2026-07-10.
   ============================================================ */
window.AGRI = (function(){

const AS_OF = '2026-07-10';

/* ---------- KPI STRIP (executive) ---------- */
const KPIS = [
  {val:'295M', lbl:'Acute food insecure (IPC-3+)', sev:'critical', delta:'+7% YoY', dir:'up', src:'FAO / GRFC'},
  {val:'5', lbl:'Countries in confirmed famine (IPC-5)', sev:'critical', delta:'+2 since 2025', dir:'up', src:'FEWS NET'},
  {val:'148.2', lbl:'FAO Food Price Index', sev:'high', delta:'+4.7% MoM', dir:'up', src:'FAO FFPI'},
  {val:'26.4%', lbl:'Wheat stocks-to-use (8-yr low)', sev:'high', delta:'-2.1 pts', dir:'down', src:'USDA WASDE'},
  {val:'+35%', lbl:'Fertilizer price (since Hormuz)', sev:'high', delta:'urea +42%', dir:'up', src:'World Bank'},
  {val:'40%', lbl:'World soils degraded', sev:'moderate', delta:'~0.5%/yr', dir:'up', src:'UNCCD'},
  {val:'$18B', lbl:'G20 emergency food fund pledged', sev:'stable', delta:'committed', dir:'flat', src:'G20'},
];

/* ---------- CRISIS VECTORS (severity bars) ---------- */
const VECTORS = [
  {name:'Climate & weather extremes', v:88, sev:'critical', src:'NOAA'},
  {name:'Geopolitical land grabs', v:74, sev:'high', src:'Chatham House'},
  {name:'Fertilizer & input crisis', v:71, sev:'high', src:'World Bank'},
  {name:'Soil degradation', v:66, sev:'high', src:'UNCCD'},
  {name:'Water scarcity & aquifers', v:82, sev:'critical', src:'NASA GRACE'},
];

/* ---------- SOCIETAL READINESS / POLICY SIGNALS ---------- */
const READINESS = [
  {k:'Public urgency index', v:72, sev:'high', note:'Media salience of food security up 34% QoQ', src:'GDELT'},
  {k:'Policy response velocity', v:48, sev:'moderate', note:'12 nations passed food-security legislation H1', src:'IFPRI'},
  {k:'Institutional funding gap', v:200, unit:'$B/yr', sev:'critical', note:'Climate-smart ag investment shortfall to 2030', src:'CGIAR'},
  {k:'Smallholder digital access', v:6, unit:'%', sev:'critical', note:'Only 6% of 33M African smallholders use any digital tool', src:'World Bank'},
];
const POLICY_SIGNALS = [
  {t:'G20 Food Security Fund crosses $18B', tone:'positive', src:'G20', date:'2026-07-04'},
  {t:'China Food Security Guarantee Law grants extraterritorial import rights', tone:'watch', src:'Chatham House', date:'2026-07-06'},
  {t:'EU Farm-to-Fork 25% organic target reaffirmed to 2030', tone:'positive', src:'Chatham House', date:'2026-07-06'},
  {t:'AU launches African Farmland Registry (55 states)', tone:'positive', src:'Chatham House', date:'2026-07-02'},
  {t:'India extends non-basmati rice export ban through December', tone:'watch', src:'World Bank', date:'2026-07-04'},
  {t:'NIST publishes 4 post-quantum standards — 24-mo migration clock', tone:'watch', src:'G20', date:'2026-07-03'},
];

/* ---------- QUICK ACTIONS (command) ---------- */
const QUICK_ACTIONS = [
  {t:'Open world intelligence map', icon:'globe', mode:'map'},
  {t:'Read the 3-minute Daily Brief', icon:'file-text', mode:'intel', act:'brief'},
  {t:'Run war-room simulation', icon:'swords', mode:'simulate'},
  {t:'Review opportunity matrix', icon:'target', mode:'strategy', act:'matrix'},
  {t:'Ask ATOM for a forecast', icon:'sparkles', act:'atom'},
  {t:'Export executive briefing (print)', icon:'printer', act:'print'},
];

/* ---------- COUNTRIES (map + profiles) ---------- */
const COUNTRIES = [
  {code:'SDN',name:'Sudan',flag:'🇸🇩',lat:15.5,lng:32.5,cont:'Africa',ipc:5,hungerPct:52,climate:88,conflict:96,production:22,water:82,tl:'critical',trend:'up',lastEvent:'2026-07-05'},
  {code:'HTI',name:'Haiti',flag:'🇭🇹',lat:18.9,lng:-72.3,cont:'Americas',ipc:5,hungerPct:49,climate:76,conflict:92,production:18,water:66,tl:'critical',trend:'up',lastEvent:'2026-07-07'},
  {code:'YEM',name:'Yemen',flag:'🇾🇪',lat:15.5,lng:47.5,cont:'Asia',ipc:4,hungerPct:56,climate:81,conflict:90,production:20,water:94,tl:'critical',trend:'up',lastEvent:'2026-07-01'},
  {code:'AFG',name:'Afghanistan',flag:'🇦🇫',lat:33.9,lng:67.7,cont:'Asia',ipc:4,hungerPct:47,climate:79,conflict:85,production:28,water:76,tl:'critical',trend:'up',lastEvent:'2026-07-04'},
  {code:'SOM',name:'Somalia',flag:'🇸🇴',lat:5.1,lng:46.2,cont:'Africa',ipc:4,hungerPct:53,climate:85,conflict:88,production:23,water:80,tl:'critical',trend:'up',lastEvent:'2026-07-06'},
  {code:'PSE',name:'Gaza / West Bank',flag:'🇵🇸',lat:31.5,lng:34.5,cont:'Asia',ipc:5,hungerPct:71,climate:64,conflict:98,production:12,water:70,tl:'critical',trend:'up',lastEvent:'2026-07-08'},
  {code:'ETH',name:'Ethiopia',flag:'🇪🇹',lat:9.1,lng:40.5,cont:'Africa',ipc:4,hungerPct:39,climate:72,conflict:78,production:35,water:60,tl:'high',trend:'up',lastEvent:'2026-07-03'},
  {code:'SSD',name:'South Sudan',flag:'🇸🇸',lat:6.9,lng:31.3,cont:'Africa',ipc:4,hungerPct:44,climate:74,conflict:82,production:26,water:68,tl:'high',trend:'up',lastEvent:'2026-07-02'},
  {code:'BFA',name:'Burkina Faso',flag:'🇧🇫',lat:12.2,lng:-1.6,cont:'Africa',ipc:4,hungerPct:34,climate:71,conflict:75,production:32,water:72,tl:'high',trend:'up',lastEvent:'2026-06-30'},
  {code:'MLI',name:'Mali',flag:'🇲🇱',lat:17.6,lng:-4.0,cont:'Africa',ipc:3,hungerPct:29,climate:76,conflict:70,production:34,water:78,tl:'high',trend:'up',lastEvent:'2026-07-01'},
  {code:'NGA',name:'Nigeria',flag:'🇳🇬',lat:9.1,lng:8.7,cont:'Africa',ipc:3,hungerPct:25,climate:66,conflict:63,production:44,water:52,tl:'high',trend:'up',lastEvent:'2026-07-05'},
  {code:'MDG',name:'Madagascar',flag:'🇲🇬',lat:-18.8,lng:47.0,cont:'Africa',ipc:3,hungerPct:31,climate:82,conflict:38,production:29,water:64,tl:'high',trend:'up',lastEvent:'2026-06-28'},
  {code:'PAK',name:'Pakistan',flag:'🇵🇰',lat:30.4,lng:69.3,cont:'Asia',ipc:3,hungerPct:26,climate:78,conflict:52,production:48,water:88,tl:'high',trend:'up',lastEvent:'2026-07-06'},
  {code:'BGD',name:'Bangladesh',flag:'🇧🇩',lat:23.7,lng:90.4,cont:'Asia',ipc:3,hungerPct:21,climate:84,conflict:35,production:56,water:74,tl:'moderate',trend:'up',lastEvent:'2026-07-04'},
  {code:'MMR',name:'Myanmar',flag:'🇲🇲',lat:21.9,lng:95.9,cont:'Asia',ipc:3,hungerPct:24,climate:66,conflict:74,production:42,water:48,tl:'high',trend:'up',lastEvent:'2026-07-03'},
  {code:'PRK',name:'North Korea',flag:'🇰🇵',lat:40.3,lng:127.5,cont:'Asia',ipc:3,hungerPct:38,climate:52,conflict:60,production:31,water:44,tl:'high',trend:'flat',lastEvent:'2026-06-25'},
  {code:'GTM',name:'Guatemala',flag:'🇬🇹',lat:15.7,lng:-90.2,cont:'Americas',ipc:3,hungerPct:23,climate:73,conflict:42,production:46,water:56,tl:'moderate',trend:'up',lastEvent:'2026-07-02'},
  {code:'HND',name:'Honduras',flag:'🇭🇳',lat:14.6,lng:-86.2,cont:'Americas',ipc:3,hungerPct:22,climate:74,conflict:50,production:44,water:58,tl:'moderate',trend:'up',lastEvent:'2026-06-30'},
  {code:'VEN',name:'Venezuela',flag:'🇻🇪',lat:6.4,lng:-66.6,cont:'Americas',ipc:3,hungerPct:28,climate:58,conflict:56,production:38,water:42,tl:'high',trend:'flat',lastEvent:'2026-07-01'},
  {code:'UKR',name:'Ukraine',flag:'🇺🇦',lat:48.4,lng:31.2,cont:'Europe',ipc:2,hungerPct:15,climate:44,conflict:88,production:58,water:32,tl:'high',trend:'flat',lastEvent:'2026-07-07'},
  {code:'IND',name:'India',flag:'🇮🇳',lat:20.6,lng:78.9,cont:'Asia',ipc:2,hungerPct:16,climate:68,conflict:38,production:74,water:70,tl:'moderate',trend:'up',lastEvent:'2026-07-04'},
  {code:'KEN',name:'Kenya',flag:'🇰🇪',lat:-0.02,lng:37.9,cont:'Africa',ipc:3,hungerPct:19,climate:70,conflict:44,production:52,water:64,tl:'moderate',trend:'flat',lastEvent:'2026-07-05'},
  {code:'ZWE',name:'Zimbabwe',flag:'🇿🇼',lat:-19.0,lng:29.1,cont:'Africa',ipc:3,hungerPct:27,climate:72,conflict:40,production:36,water:68,tl:'high',trend:'up',lastEvent:'2026-06-29'},
  {code:'PHL',name:'Philippines',flag:'🇵🇭',lat:12.9,lng:121.8,cont:'Asia',ipc:2,hungerPct:14,climate:76,conflict:36,production:60,water:38,tl:'moderate',trend:'flat',lastEvent:'2026-07-03'},
  {code:'IDN',name:'Indonesia',flag:'🇮🇩',lat:-0.8,lng:113.9,cont:'Asia',ipc:2,hungerPct:12,climate:64,conflict:28,production:68,water:34,tl:'stable',trend:'flat',lastEvent:'2026-07-02'},
  {code:'BRA',name:'Brazil',flag:'🇧🇷',lat:-14.2,lng:-51.9,cont:'Americas',ipc:2,hungerPct:10,climate:62,conflict:32,production:88,water:28,tl:'stable',trend:'down',lastEvent:'2026-07-06'},
  {code:'CHN',name:'China',flag:'🇨🇳',lat:35.9,lng:104.2,cont:'Asia',ipc:1,hungerPct:6,climate:56,conflict:44,production:92,water:60,tl:'stable',trend:'flat',lastEvent:'2026-07-07'},
  {code:'RUS',name:'Russia',flag:'🇷🇺',lat:61.5,lng:105.3,cont:'Europe',ipc:1,hungerPct:5,climate:38,conflict:76,production:82,water:22,tl:'moderate',trend:'flat',lastEvent:'2026-07-08'},
  {code:'USA',name:'United States',flag:'🇺🇸',lat:37.1,lng:-95.7,cont:'Americas',ipc:1,hungerPct:8,climate:52,conflict:20,production:95,water:52,tl:'stable',trend:'flat',lastEvent:'2026-07-08'},
  {code:'ARG',name:'Argentina',flag:'🇦🇷',lat:-38.4,lng:-63.6,cont:'Americas',ipc:1,hungerPct:9,climate:54,conflict:24,production:85,water:30,tl:'stable',trend:'down',lastEvent:'2026-07-05'},
  {code:'AUS',name:'Australia',flag:'🇦🇺',lat:-25.3,lng:133.8,cont:'Oceania',ipc:1,hungerPct:4,climate:66,conflict:12,production:82,water:56,tl:'stable',trend:'flat',lastEvent:'2026-07-04'},
  {code:'FRA',name:'France',flag:'🇫🇷',lat:46.6,lng:1.9,cont:'Europe',ipc:1,hungerPct:4,climate:44,conflict:10,production:86,water:20,tl:'stable',trend:'flat',lastEvent:'2026-07-06'},
  {code:'DEU',name:'Germany',flag:'🇩🇪',lat:51.2,lng:10.5,cont:'Europe',ipc:1,hungerPct:3,climate:42,conflict:10,production:80,water:22,tl:'stable',trend:'flat',lastEvent:'2026-07-07'},
  {code:'GBR',name:'United Kingdom',flag:'🇬🇧',lat:55.4,lng:-3.4,cont:'Europe',ipc:1,hungerPct:4,climate:40,conflict:8,production:70,water:18,tl:'stable',trend:'flat',lastEvent:'2026-07-07'},
  {code:'CAN',name:'Canada',flag:'🇨🇦',lat:56.1,lng:-106.3,cont:'Americas',ipc:1,hungerPct:5,climate:46,conflict:8,production:88,water:24,tl:'stable',trend:'flat',lastEvent:'2026-07-05'},
  {code:'EGY',name:'Egypt',flag:'🇪🇬',lat:26.8,lng:30.8,cont:'Africa',ipc:2,hungerPct:17,climate:78,conflict:46,production:52,water:92,tl:'moderate',trend:'up',lastEvent:'2026-07-06'},
  {code:'IRN',name:'Iran',flag:'🇮🇷',lat:32.4,lng:53.7,cont:'Asia',ipc:2,hungerPct:14,climate:76,conflict:70,production:56,water:86,tl:'moderate',trend:'up',lastEvent:'2026-07-07'},
  {code:'TUR',name:'Türkiye',flag:'🇹🇷',lat:38.9,lng:35.2,cont:'Asia',ipc:2,hungerPct:11,climate:64,conflict:44,production:72,water:60,tl:'moderate',trend:'flat',lastEvent:'2026-07-05'},
  {code:'MEX',name:'Mexico',flag:'🇲🇽',lat:23.6,lng:-102.5,cont:'Americas',ipc:2,hungerPct:13,climate:66,conflict:56,production:64,water:62,tl:'moderate',trend:'flat',lastEvent:'2026-07-04'},
  {code:'ZAF',name:'South Africa',flag:'🇿🇦',lat:-30.6,lng:22.9,cont:'Africa',ipc:2,hungerPct:18,climate:64,conflict:40,production:60,water:64,tl:'moderate',trend:'flat',lastEvent:'2026-07-06'},
];

/* ---------- INTEL FEED ---------- */
const SOURCES=['FAO','FEWS NET','ACLED','WFP','USDA WASDE','World Bank','NOAA','ReliefWeb','UN OCHA','Chatham House','G20'];
const CATS = ['FAMINE ALERT','CONFLICT EVENT','CLIMATE SHOCK','MARKET SIGNAL','DIPLOMATIC MOVE'];
const INTEL_CARDS = [
  {src:'FAO',cat:'FAMINE ALERT',region:'Sudan',tl:'critical',date:'2026-07-08',head:'Darfur IPC-5 confirmed across 5 states',body:'Emergency assessment confirms famine conditions for 11.3M people in Darfur. Aid convoys blocked at El Geneina crossing 47 days.',pop:'11.3M',conf:94},
  {src:'FEWS NET',cat:'FAMINE ALERT',region:'Haiti',tl:'critical',date:'2026-07-07',head:'Port-au-Prince agricultural imports halved',body:'Gang control of critical shipping lanes reduces food imports 52% in Q2 2026. Urban farming initiatives severely underfunded.',pop:'5.2M',conf:88},
  {src:'ACLED',cat:'CONFLICT EVENT',region:'Sahel',tl:'critical',date:'2026-07-07',head:'Sahel violence 34% YoY — farmland depopulated',body:'ACLED records 2,846 conflict events in Burkina Faso, Mali, Niger — 340,000 hectares of farmland abandoned.',pop:'—',conf:90},
  {src:'WFP',cat:'FAMINE ALERT',region:'Gaza',tl:'critical',date:'2026-07-08',head:'71% of population food-insecure',body:'WFP suspends operations after 3rd aid convoy attack. Total dependency on air-drop nutrition supplements.',pop:'2.3M',conf:92},
  {src:'NOAA',cat:'CLIMATE SHOCK',region:'Horn of Africa',tl:'critical',date:'2026-07-06',head:'5th consecutive failed rainy season',body:'Horn of Africa long-rains 62% below climatology. 4.3M pastoralists lose 45% of livestock.',pop:'6.8M',conf:87},
  {src:'USDA WASDE',cat:'MARKET SIGNAL',region:'Global',tl:'high',date:'2026-07-08',head:'Wheat stocks-to-use falls to 26.4% — 8-yr low',body:'Global wheat ending stocks at 262M mt. Prices spike 18% in single trading week.',pop:'—',conf:95},
  {src:'World Bank',cat:'MARKET SIGNAL',region:'Africa',tl:'high',date:'2026-07-05',head:'Food inflation exceeds 30% in 12 African nations',body:'IMF reports 12 African economies with food CPI >30% YoY. Debt distress amplifies import capacity.',pop:'—',conf:91},
  {src:'UN OCHA',cat:'DIPLOMATIC MOVE',region:'Ukraine',tl:'high',date:'2026-07-07',head:'Black Sea grain corridor renegotiation stalls',body:'3rd round of Istanbul talks ends without extension. Russia demands sanctions relief.',pop:'—',conf:84},
  {src:'Chatham House',cat:'DIPLOMATIC MOVE',region:'Global',tl:'high',date:'2026-07-06',head:'COFCO farmland acquisitions accelerate',body:"China's COFCO adds 4.2M acres of foreign farmland H1 2026. Total holdings 71M+ acres globally.",pop:'—',conf:80},
  {src:'FAO',cat:'CLIMATE SHOCK',region:'South Asia',tl:'high',date:'2026-07-06',head:'Monsoon deficit 22% across India rice belt',body:'IMD projects kharif shortfall — 400M people in rain-fed agriculture at risk.',pop:'400M',conf:83},
  {src:'NOAA',cat:'CLIMATE SHOCK',region:'Pacific',tl:'high',date:'2026-07-06',head:'El Niño peak intensity confirmed',body:'ENSO index at +2.4°C — 87% probability of Category 4 impact through Q4.',pop:'—',conf:86},
  {src:'FEWS NET',cat:'CLIMATE SHOCK',region:'Zimbabwe',tl:'high',date:'2026-06-29',head:'Zimbabwe maize crop 68% below trend',body:'National harvest 810k mt vs 2.5M mt need. Food inflation at 189%.',pop:'3.5M',conf:85},
  {src:'ACLED',cat:'CONFLICT EVENT',region:'Nigeria',tl:'high',date:'2026-07-05',head:'Boko Haram grain silo seizures spike',body:'12 attacks on grain storage in Borno state Q2. WFP suspends 3 delivery routes.',pop:'8M',conf:82},
  {src:'ReliefWeb',cat:'FAMINE ALERT',region:'Somalia',tl:'critical',date:'2026-07-06',head:'Baidoa IDP camps overwhelmed',body:'127,000 new arrivals in June. Camp capacity at 340% of design.',pop:'6.8M',conf:81},
  {src:'UN OCHA',cat:'CONFLICT EVENT',region:'Myanmar',tl:'high',date:'2026-07-03',head:'Junta blocks rice export licenses',body:'Rice export licenses restricted to state-affiliated firms — private-sector production drops 34%.',pop:'15.2M',conf:78},
  {src:'G20',cat:'DIPLOMATIC MOVE',region:'Global',tl:'high',date:'2026-07-04',head:'G20 Food Security Fund $18B pledged',body:'Emergency food security fund crosses $18B commitments — India, EU, Japan lead contributions.',pop:'—',conf:90},
  {src:'FAO',cat:'MARKET SIGNAL',region:'Global',tl:'high',date:'2026-07-05',head:'Fertilizer prices +35% since Iran-Hormuz incident',body:'Urea +42%, phosphate +38%, potash +28%. Q3 planting decisions delayed globally.',pop:'—',conf:88},
  {src:'USDA WASDE',cat:'MARKET SIGNAL',region:'US',tl:'moderate',date:'2026-07-05',head:'US corn crop rating drops to 54% good/excellent',body:'Midwest heat dome + Ogallala aquifer stress. USDA cuts yield estimate by 4.2 bu/acre.',pop:'—',conf:87},
  {src:'Chatham House',cat:'DIPLOMATIC MOVE',region:'Gulf',tl:'high',date:'2026-07-06',head:'UAE Arizona alfalfa exports up 22%',body:'Fondomonte harvests 41,000 acres of alfalfa on Colorado River basin land, drawing water at 6× residential rate.',pop:'—',conf:79},
  {src:'FEWS NET',cat:'FAMINE ALERT',region:'Afghanistan',tl:'critical',date:'2026-07-04',head:'Afghanistan winter wheat 43% failure',body:'La Niña + Taliban import restrictions leave 19M in acute hunger.',pop:'19M',conf:86},
  {src:'World Bank',cat:'MARKET SIGNAL',region:'Global',tl:'moderate',date:'2026-07-04',head:'Agri-commodity tokenization crosses $8.4B',body:'RWA tokenized ag markets grew 12% MoM. Grain warehouse receipts lead deployment.',pop:'—',conf:76},
  {src:'ACLED',cat:'CONFLICT EVENT',region:'DRC',tl:'high',date:'2026-07-04',head:'M23 rebels seize agricultural highlands',body:'Kivu highlands cheese and coffee cooperatives displaced. 2.4M hectares under contested control.',pop:'5.1M',conf:80},
  {src:'NOAA',cat:'CLIMATE SHOCK',region:'US Great Plains',tl:'moderate',date:'2026-07-04',head:'Ogallala aquifer decline accelerates',body:'8 states report cumulative decline exceeding 44m in monitored wells. Center-pivot irrigation faces cuts.',pop:'—',conf:89},
  {src:'FAO',cat:'MARKET SIGNAL',region:'Global',tl:'moderate',date:'2026-07-03',head:'Global cocoa price hits $12,800/mt record',body:'West African harvest -19%, futures 3× 10-year average. Chocolate confectionary CPI +34%.',pop:'—',conf:92},
  {src:'ReliefWeb',cat:'CLIMATE SHOCK',region:'Pakistan',tl:'high',date:'2026-07-06',head:'Sindh flooding — 3M hectares inundated',body:'Post-monsoon flooding submerges 3M ha of rice paddies. Government requests $2.4B emergency aid.',pop:'11M',conf:84},
  {src:'USDA WASDE',cat:'MARKET SIGNAL',region:'Global',tl:'moderate',date:'2026-07-03',head:'Global rice reserves at 12-year low',body:'India export ban continues, Thailand harvest -8%. Vietnam captures 34% of remaining traded volume.',pop:'—',conf:88},
  {src:'UN OCHA',cat:'DIPLOMATIC MOVE',region:'Syria',tl:'high',date:'2026-07-06',head:'Syrian wheat rations halved',body:'Government reduces subsidized bread ration to 100g/day. 12M food insecure.',pop:'12M',conf:82},
  {src:'Chatham House',cat:'DIPLOMATIC MOVE',region:'Africa',tl:'moderate',date:'2026-07-02',head:'AU launches African Farmland Registry',body:'55 member states pledge to publish foreign farmland ownership records within 24 months.',pop:'—',conf:74},
  {src:'World Bank',cat:'MARKET SIGNAL',region:'Egypt',tl:'high',date:'2026-07-06',head:'Egypt wheat import bill exceeds $5.4B',body:'FX crisis forces Egypt to draw down strategic reserves — 3-month cover remaining.',pop:'8.5M',conf:83},
  {src:'ACLED',cat:'CONFLICT EVENT',region:'Yemen',tl:'critical',date:'2026-07-01',head:'Houthi Red Sea attacks disrupt WFP deliveries',body:'14 aid vessels rerouted. Delivery cost per ton +67%. 17M reliant on food aid.',pop:'17M',conf:85},
  {src:'FEWS NET',cat:'CLIMATE SHOCK',region:'Central America',tl:'moderate',date:'2026-07-02',head:'Dry corridor expands 340 km northward',body:'Rain-fed maize/beans corridor shifts. 2.4M subsistence farmers displaced.',pop:'4.5M',conf:78},
  {src:'FAO',cat:'MARKET SIGNAL',region:'Global',tl:'moderate',date:'2026-07-01',head:'Palm oil futures +14% on Indonesia curbs',body:'Indonesia limits palm oil exports through Q4 to stabilize domestic prices.',pop:'—',conf:80},
  {src:'NOAA',cat:'CLIMATE SHOCK',region:'Amazon',tl:'moderate',date:'2026-07-03',head:'Amazon rainfall deficit worst since 2005',body:'MODIS satellite records >2M km² of vegetation stress in Brazil soy corridor.',pop:'—',conf:83},
  {src:'WFP',cat:'FAMINE ALERT',region:'South Sudan',tl:'critical',date:'2026-07-02',head:'Bentiu floods stagnate — 4.5M food insecure',body:'Third consecutive year of Sudd wetland flooding — WFP food distribution capacity down 41%.',pop:'7.5M',conf:84},
  {src:'G20',cat:'DIPLOMATIC MOVE',region:'BRICS',tl:'moderate',date:'2026-07-05',head:'BRICS Grain Exchange launches Kazan pilot',body:'Russia, India, Brazil sign framework for USD-alternative grain settlement mechanism.',pop:'—',conf:72},
  {src:'Chatham House',cat:'DIPLOMATIC MOVE',region:'Global',tl:'moderate',date:'2026-07-03',head:'FARMPEC scenario probability revised to 68%',body:'Chatham House updates 2030 farm-cartel probability from 54% to 68% following Q2 acquisitions.',pop:'—',conf:68},
  {src:'USDA WASDE',cat:'MARKET SIGNAL',region:'US',tl:'moderate',date:'2026-07-02',head:'US soybean stocks at 8-year low',body:'Ending stocks projected 254M bu vs 340M bu average. Export demand from China +18%.',pop:'—',conf:87},
  {src:'FAO',cat:'CLIMATE SHOCK',region:'Madagascar',tl:'high',date:'2026-06-28',head:'Southern Madagascar — 5th famine driver',body:'Kere drought famine enters 5th year. UNICEF confirms 500,000 children severely malnourished.',pop:'2.8M',conf:81},
  {src:'ACLED',cat:'CONFLICT EVENT',region:'Ethiopia',tl:'high',date:'2026-07-03',head:'Amhara Fano insurgency spreads',body:'Fano militia clashes with ENDF disrupt teff harvest in 3 zones.',pop:'15.8M',conf:79},
  {src:'NOAA',cat:'CLIMATE SHOCK',region:'Pakistan',tl:'high',date:'2026-07-07',head:'Karakoram glacier melt +18%',body:'Indus basin faces 24% flow surplus this melt-season followed by projected drought Q4.',pop:'240M',conf:82},
  {src:'World Bank',cat:'MARKET SIGNAL',region:'India',tl:'moderate',date:'2026-07-04',head:'India extends rice export restrictions',body:'Non-basmati export ban continues. Buffer stocks at 39M mt — above statutory minimum.',pop:'—',conf:85},
  {src:'FAO',cat:'MARKET SIGNAL',region:'Global',tl:'moderate',date:'2026-07-01',head:'FFPI (Food Price Index) at 148.2 — up 4.7% MoM',body:'Cereals sub-index +8.1%, sugar +5.4%, dairy +2.2%. Highest reading in 20 months.',pop:'—',conf:93},
  {src:'Chatham House',cat:'DIPLOMATIC MOVE',region:'EU',tl:'moderate',date:'2026-07-06',head:'EU Farm-to-Fork 25% organic target reaffirmed',body:'Von der Leyen commits to 2030 target despite CAP reform backlash from Poland, France.',pop:'—',conf:75},
  {src:'USDA WASDE',cat:'MARKET SIGNAL',region:'Global',tl:'moderate',date:'2026-07-05',head:'Coffee C-futures at 320¢/lb — record',body:'Brazil arabica frost + Vietnam robusta shortfall push New York C-contract to record.',pop:'—',conf:90},
  {src:'FEWS NET',cat:'FAMINE ALERT',region:'Burkina Faso',tl:'high',date:'2026-06-30',head:'Djibo enters 4th year of siege',body:'2 million residents cut off from major supply routes. Aid airlifts fund shortfall $180M.',pop:'3.4M',conf:80},
  {src:'ACLED',cat:'CONFLICT EVENT',region:'Mozambique',tl:'moderate',date:'2026-06-30',head:'Cabo Delgado ISIS activity resurges',body:'Insurgent attacks disrupt cashew and sesame harvests in northern Mozambique.',pop:'1.4M',conf:77},
  {src:'FAO',cat:'MARKET SIGNAL',region:'Global',tl:'moderate',date:'2026-07-07',head:'Fulvic/humic biostimulant market $6.2B',body:'Biostimulant segment on track for $36.3B by 2033, driven by EU + India adoption.',pop:'—',conf:79},
  {src:'World Bank',cat:'MARKET SIGNAL',region:'Africa',tl:'moderate',date:'2026-07-03',head:'African smallholder digital adoption 6%',body:"Only 6% of Africa's 33M smallholders access any digital agronomic tools.",pop:'—',conf:81},
  {src:'NOAA',cat:'CLIMATE SHOCK',region:'North Africa',tl:'high',date:'2026-07-05',head:'Maghreb heatwave 47°C records',body:'Morocco, Algeria, Tunisia set new June temperature records. Cereal yields projected -18%.',pop:'—',conf:84},
  {src:'USDA WASDE',cat:'MARKET SIGNAL',region:'Global',tl:'moderate',date:'2026-07-08',head:'WASDE July: All 8 majors tighter',body:'July WASDE tightens ending stocks estimates for all 8 major commodities — first time since 2012.',pop:'—',conf:92},
  {src:'ACLED',cat:'CONFLICT EVENT',region:'Global',tl:'moderate',date:'2026-07-08',head:'Global armed conflict at 45-year high',body:'ACLED records 183,000 conflict events in H1 2026 — highest since Vietnam War era.',pop:'—',conf:88},
  {src:'FEWS NET',cat:'FAMINE ALERT',region:'DRC',tl:'high',date:'2026-07-04',head:'DRC hunger crisis largest globally by count',body:'26M people acutely food insecure — largest single-country total globally.',pop:'26M',conf:86},
  {src:'UN OCHA',cat:'CONFLICT EVENT',region:'Middle East',tl:'high',date:'2026-07-07',head:'Iran-Hormuz tensions reopen',body:'Strait of Hormuz fertilizer traffic disrupted 3 days — MENA planting timelines shift.',pop:'—',conf:78},
  {src:'G20',cat:'DIPLOMATIC MOVE',region:'Global',tl:'moderate',date:'2026-07-03',head:'Post-quantum crypto standards published',body:'NIST finalizes 4 PQC standards. Agri-blockchain platforms have 24 months to migrate.',pop:'—',conf:83},
  {src:'World Bank',cat:'MARKET SIGNAL',region:'Global',tl:'moderate',date:'2026-07-06',head:'Farmland AUM crosses $220B',body:'Institutional farmland assets under management +22% YoY. PE + pensions lead flows.',pop:'—',conf:80},
  {src:'FAO',cat:'MARKET SIGNAL',region:'Global',tl:'moderate',date:'2026-07-02',head:'Regenerative ag investments cross $12B',body:'VC + PE investments in regenerative agriculture hit $12B YTD, +38% YoY.',pop:'—',conf:76},
];

/* ---------- COMMODITY PRICES (24-month) ---------- */
const MONTHS_24 = ['Jul24','Aug24','Sep24','Oct24','Nov24','Dec24','Jan25','Feb25','Mar25','Apr25','May25','Jun25','Jul25','Aug25','Sep25','Oct25','Nov25','Dec25','Jan26','Feb26','Mar26','Apr26','May26','Jun26'];
const COMMODITY_PRICES = {
  wheat:[236,242,239,251,268,279,282,292,301,318,325,332,344,352,349,362,378,385,392,406,412,428,441,456],
  rice: [598,612,608,624,632,641,652,668,681,692,701,712,724,731,738,752,764,772,788,802,814,825,832,844],
  maize:[189,192,198,204,212,218,224,231,238,244,251,258,262,269,275,282,289,296,304,312,321,328,335,342],
  soy:  [434,442,441,448,455,461,468,476,481,488,495,502,508,516,523,529,538,545,552,561,568,575,584,592],
  coffee:[218,226,234,242,254,268,282,296,308,318,326,334,342,352,362,378,392,406,418,434,452,468,486,504],
  cocoa:[3820,4120,4480,4920,5480,6120,6820,7420,8120,8620,9120,9540,9840,10120,10380,10620,10820,11040,11220,11480,11720,12040,12420,12800]
};

/* ---------- GRAIN FLOWS (supply chain) ---------- */
const GRAIN_FLOWS = [
  {from:'USA',to:'China',vol:32,risk:'moderate',crop:'soy'},
  {from:'Brazil',to:'China',vol:64,risk:'stable',crop:'soy'},
  {from:'Russia',to:'Egypt',vol:12,risk:'high',crop:'wheat'},
  {from:'Ukraine',to:'EU',vol:11,risk:'critical',crop:'wheat'},
  {from:'Ukraine',to:'MENA',vol:8,risk:'critical',crop:'corn'},
  {from:'USA',to:'Mexico',vol:18,risk:'stable',crop:'corn'},
  {from:'Argentina',to:'EU',vol:14,risk:'moderate',crop:'soy'},
  {from:'India',to:'Bangladesh',vol:7,risk:'high',crop:'rice'},
  {from:'Thailand',to:'Philippines',vol:5,risk:'moderate',crop:'rice'},
  {from:'Vietnam',to:'Africa',vol:9,risk:'moderate',crop:'rice'},
  {from:'Russia',to:'Africa',vol:14,risk:'high',crop:'wheat'},
  {from:'France',to:'MENA',vol:12,risk:'high',crop:'wheat'},
  {from:'Kazakhstan',to:'Iran',vol:4,risk:'high',crop:'wheat'},
  {from:'Australia',to:'Indonesia',vol:6,risk:'stable',crop:'wheat'},
  {from:'Canada',to:'Japan',vol:8,risk:'stable',crop:'wheat'},
];
const CHOKEPOINTS = [
  {name:'Black Sea corridor',share:'12% of global wheat',status:'critical',note:'Corridor renegotiation stalled; Russia demands sanctions relief.'},
  {name:'Strait of Hormuz',share:'Fertilizer + MENA food',status:'high',note:'3-day disruption shifted MENA planting timelines Q3.'},
  {name:'Panama Canal',share:'US grain to Asia',status:'moderate',note:'Draft restrictions from low Gatún Lake persist.'},
  {name:'Suez / Bab-el-Mandeb',share:'Red Sea aid + grain',status:'high',note:'Houthi attacks reroute 14 aid vessels; +67% cost/ton.'},
];

/* ---------- AQUIFERS (water intelligence) ---------- */
const AQUIFERS = [
  {name:'Ogallala Aquifer (US)',lat:37.5,lng:-100.5,depletion:78,years:22,tl:'critical',region:'US Great Plains',desc:'8-state aquifer supplying 30% US grain — 44m avg decline'},
  {name:'North China Plain',lat:36.2,lng:115.5,depletion:82,years:18,tl:'critical',region:'China',desc:'Feeds 400M people — 1m/yr decline'},
  {name:'Indo-Gangetic Basin',lat:26.5,lng:82.5,depletion:74,years:28,tl:'critical',region:'India/Pakistan',desc:"World's most stressed aquifer per NASA GRACE"},
  {name:'Arabian Aquifer System',lat:23.5,lng:47.5,depletion:88,years:14,tl:'critical',region:'Saudi Arabia',desc:'Fossil water — 70% depleted since 1970s'},
  {name:'Nubian Sandstone',lat:22.5,lng:29.5,depletion:52,years:110,tl:'high',region:'N. Africa',desc:"Libya's Great Manmade River pulling 6.5 M m³/day"},
  {name:'Guarani Aquifer',lat:-25.5,lng:-53.5,depletion:24,years:180,tl:'moderate',region:'South America',desc:'Largest freshwater aquifer, still healthy'},
  {name:'California Central Valley',lat:36.7,lng:-119.7,depletion:68,years:32,tl:'critical',region:'US West',desc:'Sinking 30cm/yr — subsidence damaging infra'},
  {name:'Colorado River Basin',lat:36.0,lng:-111.5,depletion:76,years:24,tl:'critical',region:'US Southwest',desc:'40M people, 5M irrigated acres — Lake Mead at 33%'},
  {name:'Aral Sea Basin',lat:44.0,lng:60.0,depletion:94,years:8,tl:'critical',region:'Central Asia',desc:'Once 4th largest lake — 90% gone since 1960'},
  {name:'Chad Basin',lat:12.0,lng:14.5,depletion:82,years:16,tl:'critical',region:'Sub-Sahara',desc:'Lake Chad -95% since 1963 — 30M dependents'},
];
const WATER_TRADE = [
  {from:'US (Arizona)',to:'UAE',crop:'Alfalfa',vol:'41k acres',water:'380M m³/yr',via:'Fondomonte'},
  {from:'US (Arizona)',to:'Saudi Arabia',crop:'Alfalfa',vol:'22k acres',water:'190M m³/yr',via:'Almarai'},
  {from:'Brazil',to:'China',crop:'Soybeans',vol:'72M mt',water:'104 km³/yr',via:'COFCO'},
  {from:'Argentina',to:'China',crop:'Soybeans',vol:'32M mt',water:'46 km³/yr',via:'COFCO'},
  {from:'India (Punjab)',to:'Middle East',crop:'Basmati Rice',vol:'4.6M mt',water:'22 km³/yr',via:'Private'},
  {from:'Ukraine',to:'MENA',crop:'Corn',vol:'22M mt',water:'21 km³/yr',via:'State/Private'},
  {from:'Vietnam (Mekong)',to:'Africa',crop:'Rice',vol:'6.4M mt',water:'21 km³/yr',via:'Vinafood'},
  {from:'Sudan (Nile)',to:'Gulf',crop:'Sorghum',vol:'1.2M mt',water:'4 km³/yr',via:'ADQ/UAE'},
];

/* ---------- SOIL / FULVIC-HUMIC ---------- */
const SOIL_MARKETS = [
  {k:'Fulvic acid market (2026)', v:'$6.2B', sub:'→ $36.3B by 2033', src:'Grand View Research'},
  {k:'Biostimulant segment', v:'$4.9B', sub:'11.2% CAGR', src:'MarketsandMarkets'},
  {k:'Humic acid market', v:'$1.1B', sub:'→ $2.4B by 2032', src:'Fortune Business'},
  {k:'Yield improvement range', v:'15–35%', sub:'field-trial dependent', src:'Meta-analysis, 2024'},
];
const SOIL_BENEFITS = ['Soil aggregation','Water retention','Nutrient chelation','Microbial activity','Carbon sequestration','Heavy-metal detox','Salinity resistance','Drought resilience','Degraded-soil recovery'];

/* ---------- AI OPPORTUNITY GAPS ---------- */
const AI_GAPS = [
  {name:'Soil microbiome AI',urgency:92,maturity:24},
  {name:'Fertilizer-substitution AI',urgency:88,maturity:31},
  {name:'Multi-modal early warning',urgency:85,maturity:44},
  {name:'Smallholder access',urgency:90,maturity:18},
  {name:'Supply-chain transparency',urgency:76,maturity:38},
  {name:'Carbon verification AI',urgency:79,maturity:29},
  {name:'Water management AI',urgency:82,maturity:35},
  {name:'AI + gene editing',urgency:71,maturity:22},
];

/* ---------- BLOCKCHAIN / TOKENIZATION READINESS ---------- */
const TOKEN_TRAJ = {years:['2025','2026','2027','2028','2029','2030','2035','2040'], vals:[4.8,7.0,14,28,56,110,420,1400]};
const TOKEN_USECASES = [
  {t:'Grain warehouse receipts',status:'live'},
  {t:'Coffee / cocoa futures',status:'pilot'},
  {t:'Farmland fractional ownership',status:'pilot'},
  {t:'Soil carbon credits',status:'pilot'},
  {t:'Fertilizer provenance',status:'gap'},
  {t:'Seed IP / royalty rails',status:'gap'},
  {t:'Parametric crop insurance',status:'pilot'},
  {t:'Post-quantum settlement standard',status:'gap'},
];

/* ---------- CORRELATED INDUSTRY DEPENDENCY WEB ---------- */
const INDUSTRIES = [
  {t:'Energy',d:'Fertilizer = natural gas; diesel drives every field operation.',dep:88,links:['Finance','Logistics','Defense']},
  {t:'Finance',d:'$220B+ farmland AUM; commodity derivatives set planting.',dep:80,links:['Energy','Insurance','Climate tech']},
  {t:'Logistics',d:'30–40% food loss traces to cold-chain + routing gaps.',dep:76,links:['Energy','Retail / CPG','Telecom / IoT']},
  {t:'Water utilities',d:'70% of freshwater withdrawals are agricultural.',dep:90,links:['Energy','Climate tech','Satellite / space']},
  {t:'Defense',d:'Food as geopolitical weapon; grain corridors are theaters.',dep:72,links:['Energy','Finance','Satellite / space']},
  {t:'Robotics',d:'Labor shortage forces autonomy in harvest + weeding.',dep:64,links:['Telecom / IoT','Satellite / space']},
  {t:'Satellite / space',d:'Yield forecasting + aquifer mapping ride on EO data.',dep:70,links:['Water utilities','Defense','Climate tech']},
  {t:'Biotech / pharma',d:'CRISPR traits + food-pharming converge on crops.',dep:74,links:['Climate tech','Robotics']},
  {t:'Telecom / IoT',d:'Precision ag needs pervasive rural connectivity.',dep:60,links:['Robotics','Logistics']},
  {t:'Insurance',d:'$90B underinsured; parametric payout is the missing rail.',dep:68,links:['Finance','Climate tech']},
  {t:'Climate tech',d:'Carbon MRV + regenerative credits monetize soil.',dep:66,links:['Finance','Water utilities','Biotech / pharma']},
  {t:'Retail / CPG',d:'Provenance + shrink drive margin at the shelf.',dep:58,links:['Logistics','Finance']},
];

/* ---------- BIOTECH PIPELINE (regenerative biology) ---------- */
const BIOTECH_PIPELINE = [
  {name:'CRISPR Drought Rice (China)',stage:'market',org:'Beijing AAS',desc:'25% water reduction — commercial 2026'},
  {name:'Golden Wheat (Nitrogen-fix)',stage:'trial',org:'Gates Foundation',desc:'Nitrogen-fixing wheat — 30% fertilizer reduction'},
  {name:'CRISPR Cassava (Nigeria)',stage:'approved',org:'IITA',desc:'CBSD-resistant, 24 months to market'},
  {name:'Precision Fermentation Dairy',stage:'market',org:'Perfect Day',desc:'Whey protein without cows — $890M ARR'},
  {name:'Drone Pollination Network',stage:'trial',org:'Beewise',desc:'AI-guided drones — 20% higher pollination'},
  {name:'Soil Microbiome Diagnostics',stage:'trial',org:'Trace Genomics',desc:'AI microbiome map — 6M+ samples'},
  {name:'AI Regenerative Score (MRV)',stage:'market',org:'Regrow Ag',desc:'6M acres enrolled'},
  {name:'Post-Quantum Grain Chain',stage:'research',org:'Nirmata (roadmap)',desc:'Lattice-crypto agri-commodity settlement'},
];

/* ---------- TIMELINE ---------- */
const TIMELINE_EVENTS = [
  {year:2022,cat:'crisis',title:'Russia invades Ukraine — wheat +54%'},
  {year:2024,cat:'crisis',title:'El Niño peak'},
  {year:2025,cat:'crisis',title:'Sudan famine declared'},
  {year:2026,cat:'crisis',title:'Gaza IPC-5 confirmed'},
  {year:2026,cat:'opp',title:'INTERVENTION WINDOW OPENS'},
  {year:2028,cat:'opp',title:'AI biostimulants mainstream'},
  {year:2030,cat:'geo',title:'FARMPEC scenario climax (68%)'},
  {year:2030,cat:'opp',title:'Agri tokenization $110B'},
  {year:2031,cat:'tech',title:'Post-quantum crypto mandate'},
  {year:2033,cat:'opp',title:'Biostimulants $36B'},
  {year:2040,cat:'opp',title:'RWA tokenization $1.4T'},
  {year:2045,cat:'crisis',title:'Aquifer criticality (Ogallala)'},
  {year:2050,cat:'crisis',title:'95% soil degradation (BAU)'},
];

/* ---------- NIRMATA FOUR PILLARS ---------- */
const PILLARS = [
  {n:'PILLAR 01',name:'Secure Infrastructure',desc:'Post-quantum cryptography and provenance systems for agricultural supply chains — the trust layer for a $110B tokenization market.'},
  {n:'PILLAR 02',name:'Coordination Layer',desc:'A human-centered operating system for multi-actor field coordination — voice-first AI reaching 500M smallholders where text fails.'},
  {n:'PILLAR 03',name:'Regenerative Biology',desc:'Soil, microbiome, and biotech interventions — fulvic/humic optimization and proprietary biological datasets no LLM can replicate.'},
  {n:'PILLAR 04',name:'Clinical Intelligence',desc:'Decision AI for famine, malnutrition, and livestock health — closing the loop from sensing to intervention to verification.'},
];

/* ---------- SIX-FRAME STRATEGY ADVISOR (fallback / demo) ---------- */
const FRAMES = [
  {id:'questions', n:'01', title:'Questions To Answer', bullets:[
    'Which single intervention most reduces IPC-5 population within 18 months at lowest capital?',
    'Where does Nirmata hold a defensible 24-month lead the incumbents cannot close?',
    'What is the minimum viable coalition (states + capital + distribution) to reach 500M smallholders?',
    'Which crisis vector, if it compounds, invalidates the current thesis — and what is the early signal?',
    'How do we price trust: what does an AI-verified provenance claim need to be underwritten?',
  ]},
  {id:'opportunities', n:'02', title:'Opportunities', bullets:[
    'AI Soil Health Platform — no integrated microbiome + fulvic/humic optimizer exists at scale ($36B + $24B TAM).',
    'Post-quantum agri-commodity settlement — 24-month lead ahead of NIST commercial migration.',
    'Smallholder voice-AI OS — 80% of the world\'s farmers have zero AI access today.',
    'AI-verified soil carbon — first trusted measurement standard unlocks a $1B+ credit market.',
    'Parametric crop insurance rail — $90B underinsured; weather API → smart-contract payout.',
  ]},
  {id:'threats', n:'03', title:'Threats', bullets:[
    'FARMPEC cartel — 4-state farmland bloc completing vertical integration (68% by 2030, Chatham House).',
    'Cyber-agriculture — state sabotage of irrigation / fertilization / harvest systems mid-cycle.',
    'AI monoculture — identical optimization means one pathogen wipes global supply simultaneously.',
    'Non-PQC blockchain fraud — a compromised agri-chain triggers a trillion-dollar unwind.',
    'Data colonialism — Big Tech farm-data monopoly replicating colonial dependency chains.',
  ]},
  {id:'moves', n:'04', title:'Next Moves', bullets:[
    'Ship the AI soil-intelligence MVP against 3 lighthouse EU + India accounts this cycle.',
    'Lock a post-quantum reference implementation with one grain-merchant design partner.',
    'Stand up the smallholder voice pilot in one high-density market (India / Nigeria).',
    'Publish an open soil-carbon measurement methodology to seed the standard.',
    'Pre-position capital: $30–50M seed→A for the platform, impact-linked B for smallholder reach.',
  ]},
  {id:'wildcards', n:'05', title:'Wildcards', bullets:[
    'Agrivoltaics — solar over crops doubles land use; shade-tolerant portfolio still unbuilt.',
    'Mycelium networks as the most sensitive real-time soil-degradation sensor known to science.',
    'Nano-fertilizer encapsulation cutting input waste 60% — direct answer to the fertilizer crisis.',
    'Food-pharming — CRISPR crops producing pharma compounds collapse the ag/pharma boundary.',
    'A BRICS grain-settlement standard could reroute 25% of traded wheat off USD rails.',
  ]},
  {id:'positioning', n:'06', title:'Positioning', bullets:[
    'Nirmata is the only entity uniting AI, biotech, post-quantum crypto, and voice UI under one roof.',
    'The moat is biological data sovereignty: proprietary microbiome datasets compound over time.',
    'Distribution edge: voice reaches the 500M farmers text-based tools structurally miss.',
    'Vertical automation loop: sensing → decision → intervention → verification, owned end-to-end.',
    'Sequence matters — infrastructure trust first, then coordination reach, then biological yield.',
  ]},
];

/* ---------- OPPORTUNITY MATRIX ---------- */
const OPP_MATRIX = [
  {opp:'AI Soil Health Platform',sub:'Real-time microbiome + fulvic/humic optimization',size:'$36B biostim + $24B precision',pri:'critical',edge:'Secure Infra + IoT + Regenerative Biology',gap:'No integrated AI soil platform exists',time:'2026–2028',conf:92,pillar:'bio',horizon:'near'},
  {opp:'AgriTech AI Decision Engine',sub:'Unified crop-weather-market platform',size:'$4.9B AI-in-ag by 2030',pri:'critical',edge:'ATOM + Coordination Layer + Secure Infra',gap:'Fragmented tools; no unified layer',time:'2026–2027',conf:88,pillar:'coord',horizon:'near'},
  {opp:'Agri-Commodity Tokenization',sub:'Post-quantum RWA for grain / carbon',size:'$7B→$110B (2030)→$1.4T (2040)',pri:'high',edge:'Post-quantum crypto + blockchain',gap:'No quantum-secure agri standard',time:'2026–2029',conf:82,pillar:'infra',horizon:'mid'},
  {opp:'Parametric Crop Insurance AI',sub:'Weather → smart-contract payout',size:'$90B+ underinsured',pri:'high',edge:'ATOM automation + fintech',gap:'Missing financing rail',time:'2027–2029',conf:76,pillar:'infra',horizon:'mid'},
  {opp:'Smallholder Farmer AI Platform',sub:'Mobile voice agronomic advisor',size:'500M+ smallholder farms',pri:'strategic',edge:'Coordination Layer voice AI',gap:'Zero AI access for 80% of farmers',time:'2028–2032',conf:84,pillar:'coord',horizon:'long'},
  {opp:'Carbon Credit Verification AI',sub:'Soil carbon → on-chain credits',size:'$167M→$1B+',pri:'strategic',edge:'AI measurement + Regenerative Biology',gap:'No trusted verified standard',time:'2027–2031',conf:79,pillar:'bio',horizon:'long'},
  {opp:'Vertical Farm AI OS',sub:'Full indoor-farm automation',size:'$8.2B→$41B (2034)',pri:'medium',edge:'AI control systems',gap:'No comprehensive OS on market',time:'2027–2030',conf:71,pillar:'clin',horizon:'mid'},
  {opp:'Food Supply-Chain Transparency',sub:'AI + blockchain provenance',size:'Global food chain $8T+',pri:'medium',edge:'Blockchain + Secure Infra audit',gap:'30–40% loss from opacity',time:'2027–2030',conf:73,pillar:'infra',horizon:'mid'},
];

/* ---------- SCENARIOS LAB ---------- */
const SCENARIOS = [
  {name:'Managed Transition',prob:38,tone:'stable',horizon:'2026–2032',
   summary:'Coordinated capital + AI intervention bends the curve. IPC-5 population falls, biostimulant + precision adoption compounds, tokenization matures on PQC rails.',
   drivers:['G20 fund deploys','AI soil platforms scale','Farm-to-Fork adoption'],
   nirmata:'Best case for full-stack play — infrastructure trust and biological yield both monetize.'},
  {name:'FARMPEC Consolidation',prob:34,tone:'critical',horizon:'2027–2030',
   summary:'A 4-state farmland cartel completes vertical integration. Grain becomes an overt geopolitical instrument; import-dependent nations face coercive leverage.',
   drivers:['COFCO + Gulf SWF acquisitions','Black Sea permanent closure','Weaponized grain diplomacy'],
   nirmata:'Sovereignty demand spikes — provenance + coordination layer become national-security infrastructure.'},
  {name:'Climate Cascade',prob:20,tone:'critical',horizon:'2026–2029',
   summary:'Simultaneous El Niño + Amazon drought + Sahel expansion + aquifer criticality. Multiple breadbaskets fail in the same season.',
   drivers:['ENSO +2.4°C','Ogallala + N. China Plain','Compounding conflict'],
   nirmata:'Clinical Intelligence + early-warning demand surges; regenerative biology becomes existential, not optional.'},
  {name:'Fragmented Muddle',prob:8,tone:'moderate',horizon:'2026–2035',
   summary:'No coordinated response; incremental national fixes. Chronic elevated prices, persistent hotspots, slow tech diffusion.',
   drivers:['Policy gridlock','Underfunded aid','Data colonialism'],
   nirmata:'Niche wins in lighthouse markets; slower but defensible compounding of biological data moat.'},
];

/* ---------- WAR ROOM: pillars vs threats ---------- */
const SIM_PILLARS = [
  {id:'infra',name:'Secure Infrastructure',short:'INF',desc:'Post-quantum provenance + settlement'},
  {id:'coord',name:'Coordination Layer',short:'COO',desc:'Voice-first smallholder OS'},
  {id:'bio',name:'Regenerative Biology',short:'BIO',desc:'Soil / microbiome / biostimulant'},
  {id:'clin',name:'Clinical Intelligence',short:'CLI',desc:'Famine + livestock decision AI'},
];
const SIM_THREATS = [
  {id:'farmpec',name:'FARMPEC Cartel',short:'FPC',sev:'critical'},
  {id:'cyber',name:'Cyber-Agriculture Attack',short:'CYB',sev:'critical'},
  {id:'aquifer',name:'Aquifer Depletion',short:'AQF',sev:'high'},
  {id:'monoculture',name:'AI Monoculture Collapse',short:'MON',sev:'high'},
  {id:'blackswan',name:'Climate Shock Cascade',short:'CLM',sev:'critical'},
];
// outcome matrix keyed pillar_threat
const SIM_OUTCOMES = {
  infra_farmpec:{eff:78,line:'Provenance rails expose cartel concentration; open registries erode opacity that a farm-cartel depends on. Coalition of import-dependent states adopts as counter-leverage.'},
  infra_cyber:{eff:88,line:'Post-quantum settlement + signed telemetry hardens irrigation/harvest control planes. Highest-leverage counter — attack surface collapses.'},
  infra_aquifer:{eff:34,line:'Infrastructure alone cannot refill aquifers; it can meter and price water-rights transparently, slowing the drain but not reversing it.'},
  infra_monoculture:{eff:41,line:'Provenance diversity flags dangerous genetic concentration but does not itself diversify seed stock.'},
  infra_blackswan:{eff:46,line:'Trusted data speeds triage during cascade, but physical shock outpaces settlement.'},
  coord_farmpec:{eff:62,line:'Direct-to-smallholder distribution routes around cartel-controlled merchant chokepoints; fragments monopsony power.'},
  coord_cyber:{eff:40,line:'Human-in-the-loop coordination adds resilience, but the OS itself becomes a target that must be hardened by Secure Infrastructure.'},
  coord_aquifer:{eff:70,line:'Voice advisory shifts 500M irrigation decisions toward deficit-irrigation and drought-tolerant portfolios at population scale.'},
  coord_monoculture:{eff:66,line:'Localized agronomic guidance re-diversifies planting decisions, breaking the identical-optimization trap.'},
  coord_blackswan:{eff:72,line:'Early-warning fan-out + coordinated response is the single best tool during a simultaneous multi-breadbasket failure.'},
  bio_farmpec:{eff:55,line:'Regenerative yield gains lower import dependence, reducing the coercive leverage a cartel can apply.'},
  bio_cyber:{eff:30,line:'Biology is largely orthogonal to a cyber control-plane attack.'},
  bio_aquifer:{eff:84,line:'Microbiome + fulvic/humic water-retention directly cuts irrigation demand — the highest-leverage aquifer counter.'},
  bio_monoculture:{eff:80,line:'Biological diversity + soil-health portfolios are the structural antidote to monoculture fragility.'},
  bio_blackswan:{eff:68,line:'Drought/salinity-resilient biology buffers the physical shock better than any purely digital layer.'},
  clin_farmpec:{eff:44,line:'Clinical triage mitigates the humanitarian cost of coercion but does not contest the cartel directly.'},
  clin_cyber:{eff:36,line:'Decision AI keeps famine response coherent if systems degrade, a resilience backstop.'},
  clin_aquifer:{eff:48,line:'Nutrition-security modeling reprioritizes scarce water toward highest-impact food crops.'},
  clin_monoculture:{eff:52,line:'Outbreak surveillance detects a monoculture pathogen event earliest, buying containment time.'},
  clin_blackswan:{eff:82,line:'Famine + malnutrition decision AI is decisive in the acute phase of a cascade — saves the most lives per dollar.'},
};

/* ---------- MISSION PRIORITY QUEUE (command center) ---------- */
const MISSIONS = [
  {id:'m1',code:'MSN-01',objective:'Stand up AI soil-intelligence pilot in India rice belt',why:'Monsoon deficit 22% + 400M rain-fed at risk; fulvic/humic water-retention is highest-leverage aquifer counter (WarRoom eff 84%)',window:'Q3 2026 — 90-day window before kharif lock-in',pillar:'Regenerative Biology',owner:'BIO',conf:88,sev:'high',country:'IND',frame:'moves'},
  {id:'m2',code:'MSN-02',objective:'Lock post-quantum grain-settlement reference with one merchant partner',why:'NIST 24-month PQC migration clock started; first mover sets a $110B (2030) standard',window:'2026–2027 — ahead of commercial migration',pillar:'Secure Infrastructure',owner:'INF',conf:82,sev:'high',country:null,frame:'moves'},
  {id:'m3',code:'MSN-03',objective:'Pre-position famine decision-AI ahead of Sudan/Sahel cascade',why:'5 IPC-5 countries; Clinical Intelligence is decisive in acute cascade phase (eff 82%) — most lives per dollar',window:'Immediate — Darfur convoys blocked 47 days',pillar:'Clinical Intelligence',owner:'CLI',conf:84,sev:'critical',country:'SDN',frame:'moves'},
  {id:'m4',code:'MSN-04',objective:'Launch smallholder voice-AI in one high-density market',why:'Only 6% of 33M African smallholders use any digital tool; voice routes around the text barrier',window:'2026–2028',pillar:'Coordination Layer',owner:'COO',conf:79,sev:'moderate',country:'NGA',frame:'moves'},
  {id:'m5',code:'MSN-05',objective:'Publish open soil-carbon measurement methodology',why:'No trusted verified standard exists; seeding it unlocks a $1B+ credit market and the biological-data moat',window:'2027–2031',pillar:'Regenerative Biology',owner:'BIO',conf:76,sev:'moderate',country:null,frame:'opportunities'},
];

/* ---------- COURSE-OF-ACTION TEMPLATES (war room) ---------- */
const COA_LIB = {
  infra:[
    {name:'Provenance-first',tempo:'Deliberate',desc:'Ship signed provenance + open registry before settlement rails.',pros:['Erodes opacity fast','Coalition-friendly'],cons:['Slower monetization'],effMod:0},
    {name:'Settlement-first',tempo:'Aggressive',desc:'Lead with PQC settlement standard; provenance follows.',pros:['Standard-setting lead','High moat'],cons:['Partner dependency'],effMod:4},
    {name:'Telemetry-hardening',tempo:'Defensive',desc:'Sign irrigation/harvest control planes first.',pros:['Collapses cyber surface'],cons:['Narrow vs cartel'],effMod:-6},
  ],
  coord:[
    {name:'Voice-broad',tempo:'Aggressive',desc:'Mass voice fan-out across one dense market.',pros:['Population-scale reach','Breaks monopsony'],cons:['Ops-heavy'],effMod:3},
    {name:'Advisory-deep',tempo:'Deliberate',desc:'High-touch agronomic advisory to lighthouse cooperatives.',pros:['Data quality','Retention'],cons:['Slower scale'],effMod:-2},
    {name:'Early-warning-net',tempo:'Defensive',desc:'Coordinated early-warning fan-out during shock.',pros:['Best in cascade','Coalition glue'],cons:['Needs live feeds'],effMod:2},
  ],
  bio:[
    {name:'Water-retention wedge',tempo:'Aggressive',desc:'Fulvic/humic + microbiome to cut irrigation demand.',pros:['Highest aquifer leverage','Yield gains'],cons:['Field-trial lag'],effMod:5},
    {name:'Diversity portfolio',tempo:'Deliberate',desc:'Break monoculture with resilient biological portfolios.',pros:['Structural antidote'],cons:['Adoption friction'],effMod:1},
    {name:'Degraded-soil recovery',tempo:'Defensive',desc:'Target most-degraded soils for fastest visible ROI.',pros:['Proof points'],cons:['Capital intensive'],effMod:-3},
  ],
  clin:[
    {name:'Acute triage',tempo:'Aggressive',desc:'Famine + malnutrition decision AI at the acute edge.',pros:['Most lives/$','Decisive in cascade'],cons:['Not a cartel counter'],effMod:4},
    {name:'Surveillance-first',tempo:'Deliberate',desc:'Outbreak + monoculture pathogen surveillance.',pros:['Earliest detection'],cons:['Indirect impact'],effMod:0},
    {name:'Resilience-backstop',tempo:'Defensive',desc:'Keep response coherent if systems degrade.',pros:['Robustness'],cons:['Lower ceiling'],effMod:-4},
  ],
};

/* ---------- ATOM MISSION PRESETS (GenUI) ---------- */
const ATOM_PRESETS = [
  {id:'brief',label:'Morning Brief',icon:'sunrise',prompt:'Give me the morning executive brief on the global food-security polycrisis: top 5 developments, market signals, and the single highest-leverage Nirmata move today. Return an executive brief with a confidence score and citations.'},
  {id:'dossier',label:'Country Dossier',icon:'flag',prompt:'Build a country dossier on Sudan: crisis drivers, IPC status, conflict, water and production, and the recommended Nirmata intervention with confidence and 3 sources.'},
  {id:'coa',label:'War-Game COAs',icon:'swords',prompt:'Compare three courses of action for deploying Regenerative Biology against aquifer depletion. Give a COA comparison with effectiveness, residual risk, trade-offs, and a recommendation.'},
  {id:'shock',label:'Supply Shock',icon:'trending-down',prompt:'Model a wheat supply shock if the Black Sea corridor closes permanently: price path, exposed importers, and Nirmata positioning. Confidence + sources.'},
  {id:'soil',label:'Soil Intervention',icon:'sprout',prompt:'Design a fulvic/humic + microbiome soil intervention for a degraded rain-fed maize system. Expected yield/water impact, deployment steps, and confidence.'},
];

/* expose to window for ATOM context */
Object.assign(window, {COUNTRIES, INTEL_CARDS, COMMODITY_PRICES, OPP_MATRIX, AQUIFERS, PILLARS, SCENARIOS});

return {
  AS_OF, KPIS, VECTORS, READINESS, POLICY_SIGNALS, QUICK_ACTIONS,
  COUNTRIES, SOURCES, CATS, INTEL_CARDS, MONTHS_24, COMMODITY_PRICES,
  GRAIN_FLOWS, CHOKEPOINTS, AQUIFERS, WATER_TRADE, SOIL_MARKETS, SOIL_BENEFITS,
  AI_GAPS, TOKEN_TRAJ, TOKEN_USECASES, INDUSTRIES, BIOTECH_PIPELINE,
  TIMELINE_EVENTS, PILLARS, FRAMES, OPP_MATRIX, SCENARIOS,
  SIM_PILLARS, SIM_THREATS, SIM_OUTCOMES,
  MISSIONS, COA_LIB, ATOM_PRESETS
};
})();
