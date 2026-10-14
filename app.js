/* =========================================================================
   Ontology Mapping Studio — maps CSV columns to OWL ontology concepts
   Pipeline: lexical match → value profiling heuristics → OWL validation
   → human confirmation → YAML / R2RML / JSON export.
   Everything runs client-side; no data leaves the browser.
   ========================================================================= */
"use strict";
window.__APP_LOADED__ = true;   // checked by index.html to detect a missing/404 app.js

/* ---- visible error reporting: nothing may fail silently ---- */
function showFatal(msg){
  let b=document.getElementById("fatal");
  if(!b){ b=document.createElement("div"); b.id="fatal";
    b.style.cssText="background:#fdecea;border:1px solid #b3433b;color:#7a2d28;border-radius:8px;padding:9px 12px;margin:10px 0;font-size:13px;white-space:pre-wrap";
    document.body.prepend(b); }
  b.textContent += (b.textContent?"\n":"")+"⚠ "+msg;
  console.error(msg);
}
window.addEventListener("error", e=>showFatal((e.message||"script error")+(e.filename?"  ["+e.filename.split("/").pop()+":"+e.lineno+"]":"")));
window.addEventListener("unhandledrejection", e=>showFatal("async error: "+((e.reason&&(e.reason.message||e.reason))||"unknown")));

let ONT = null;          // ontology model built from a user-loaded .ttl/.rdf/.owl file
let CFG = {};            // optional well-known concepts resolved by URI from the loaded ontology
let STATE = { fileName:null, headers:[], rows:[], cols:[], maps:[] };
const LS_KEY = "ontology-mapping-studio-v1";
/* generic keywords hinting that a date column is a milestone/event (used only when the
   loaded ontology actually contains a milestone-like class, see CFG) */
const MS_KEYWORDS=["siv","fpfv","initiation visit","activation","qualification","training","calibration","questionnaire","shipment","received","submitted","completed","visit","milestone"];

/* ---------------------- utilities ---------------------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const STOP = new Set(["the","a","an","of","in","at","for","to","is","date","and","or","list","added","sent","required"]);
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g," ").replace(/\s+/g," ").trim();
const sing = w => (w.length>3 && w.endsWith("s") && !w.endsWith("ss")) ? w.slice(0,-1) : w;
const toks = s => norm(s).split(" ").filter(w=>w && !STOP.has(w)).map(sing);
function dice(a,b){ if(!a.length||!b.length) return 0; const A=new Set(a),B=new Set(b); let i=0; A.forEach(x=>{if(B.has(x))i++;}); return 2*i/(A.size+B.size); }
function excelToISO(n){ const d=new Date(Math.round((n-25569)*86400000)); return isNaN(d)?String(n):d.toISOString().slice(0,10); }

function entity(id){
  if(!id) return null;
  return ONT.classes[id] || ONT.dataProperties[id] || ONT.objectProperties[id] || ONT.individuals[id] || null;
}
const lbl = id => (entity(id)||{label:id}).label;
const uri = id => (entity(id)||{uri:id}).uri;

function ancestors(id, seen){
  seen = seen || new Set(); const out=[]; const c=ONT.classes[id]; if(!c) return out;
  for(const p of (c.parents||[])){ if(seen.has(p)) continue; seen.add(p); out.push(p, ...ancestors(p,seen)); }
  return out;
}

/* ---------------------- CSV parser (handles quotes + embedded newlines) ---------------------- */
function parseCSV(text){
  const delim = (text.split(";").length > text.split(",").length) ? ";" : ",";
  const rows=[]; let row=[], field="", inQ=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(inQ){
      if(ch==='"'){ if(text[i+1]==='"'){ field+='"'; i++; } else inQ=false; }
      else field+=ch;
    } else {
      if(ch==='"') inQ=true;
      else if(ch===delim){ row.push(field); field=""; }
      else if(ch==="\n"||ch==="\r"){ if(ch==="\r"&&text[i+1]==="\n") i++; row.push(field); field="";
        if(row.length>1||row[0]!=="") rows.push(row); row=[]; }
      else field+=ch;
    }
  }
  if(field!==""||row.length) { row.push(field); if(row.length>1||row[0]!=="") rows.push(row); }
  if(!rows.length) return {headers:[],rows:[]};
  // headers: trim, collapse newlines, name blanks, dedupe
  const seen={};
  const headers = rows[0].map((h,i)=>{
    let n = String(h).replace(/\s+/g," ").trim() || ("Column_"+(i+1));
    if(seen[n]!=null){ seen[n]++; n = n+"_"+seen[n]; } else seen[n]=0;
    return n;
  });
  const data = rows.slice(1).map(r=>{ const o={}; headers.forEach((h,i)=>o[h]=(r[i]??"").trim()); return o; });
  return {headers, rows:data};
}

/* ---------------------- column profiling ---------------------- */
function profileColumn(name, rows){
  const vals = rows.map(r=>r[name]).filter(v=>v!=="" && v!=null);
  const distinct=[...new Set(vals)];
  let nNum=0,nSerial=0,nYN=0;
  for(const v of vals){
    const f=parseFloat(v);
    if(!isNaN(f) && /^[\d.]+$/.test(v)){ nNum++; if(f>40000&&f<48000) nSerial++; }
    if(/^(y|n|yes|no)$/i.test(v)) nYN++;
  }
  let type="text";
  if(vals.length && nSerial/vals.length>=0.6) type="excel-date";
  else if(vals.length && nYN/vals.length>=0.8) type="boolean";
  else if(vals.length && nNum===vals.length) type="number";
  if(!vals.length) type="empty";
  const nm=norm(name);
  return {
    name, type, nonEmpty:vals.length, samples:distinct.slice(0,3), distincts:distinct.slice(0,40),
    isJunk: /^column_?\d*$/i.test(nm)||nm==="y n"||nm==="yes no"||nm==="planned actual"||nm==="",
    planned: /\bplanned?\b/i.test(name) && !/actual/i.test(name),
    actual: /\bactual\b/i.test(name) && !/plann/i.test(name),
    dateWord: /(date|visit|completed|completion|submitted|received|activation|qualified)/i.test(name)
  };
}

/* ---------------------- lexical matching ---------------------- */
function lexCandidates(colName){
  const ct=toks(colName); const out=[];
  const pools=[["class",ONT.classes],["dataProperty",ONT.dataProperties],["individual",ONT.individuals]];
  for(const [kind,pool] of pools){
    for(const [id,e] of Object.entries(pool)){
      const names=[e.label, ...(e.syns||[]), e.longName].filter(Boolean);
      let best=0, how="", term="";
      for(const n of names){
        const nn=norm(n); if(!nn) continue;
        if(norm(colName)===nn){ if(0.97>best){best=0.97;how="exact";term=n;} continue; }
        if((" "+norm(colName)+" ").includes(" "+nn+" ")){ if(0.9>best){best=0.9;how="contains";term=n;} continue; }
        const d=dice(ct,toks(n));
        if(d>=0.5 && 0.45+0.35*d>best){ best=0.45+0.35*d; how="partial"; term=n; }
      }
      if(best>0) out.push({id,kind,conf:best,how,term});
    }
  }
  return out.sort((a,b)=>b.conf-a.conf);
}

/* ---------------------- semantic matching (all-MiniLM-L6-v2 via transformers.js) ---------------------- */
/* The model runs fully in the browser (ONNX/WASM). Two hosting options:
   A) Default below: transformers.js fetches the ONNX build "Xenova/all-MiniLM-L6-v2"
      from the Hugging Face CDN on first use (≈23 MB quantized, then cached by the browser).
   B) Self-hosted on your GitHub Pages repo (works behind strict proxies):
      copy the ONNX model files into ./models/all-MiniLM-L6-v2/
      (config.json, tokenizer.json, tokenizer_config.json, onnx/model_quantized.onnx
       — note: a plain sentence-transformers download like C:\models\all-MiniLM-L6-v2
       contains PyTorch weights; the browser needs the ONNX variant, e.g. from
       huggingface.co/Xenova/all-MiniLM-L6-v2) and set SELF_HOSTED = true. */
const SELF_HOSTED_MODEL = false;
const SEM = { ready:false, pipe:null, entities:[], vecs:null };

async function initSemantic(){
  const st=$("semStatus");
  try{
    st.textContent="loading transformers.js…";
    const T = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3");
    if(SELF_HOSTED_MODEL){ T.env.allowRemoteModels=false; T.env.localModelPath="./models/"; }
    st.textContent="loading all-MiniLM-L6-v2 (first time may take a moment)…";
    SEM.pipe = await T.pipeline("feature-extraction",
      SELF_HOSTED_MODEL ? "all-MiniLM-L6-v2" : "Xenova/all-MiniLM-L6-v2");
    $("semBtn").disabled = true;
    if(ONT) await embedOntology();
    else st.textContent="✓ model loaded — will embed entities once an ontology is loaded";
  }catch(e){
    console.error("semantic init failed", e);
    st.textContent = "✗ model unavailable ("+e.message+") — continuing with lexical + OWL only";
  }
}
/* (re)embed all entities of the currently loaded ontology */
async function embedOntology(){
  if(!SEM.pipe || !ONT) return;
  SEM.ready=false;
  $("semStatus").textContent="embedding ontology entities…";
  SEM.entities=[]; const texts=[];
  for(const pool of [ONT.classes, ONT.dataProperties, ONT.individuals]){
    const kind = pool===ONT.classes?"class":pool===ONT.dataProperties?"dataProperty":"individual";
    for(const [id,e] of Object.entries(pool)){
      if(e.unlabeled) continue;
      SEM.entities.push({id,kind});
      texts.push([e.label, ...(e.syns||[]), e.longName||"", e.def||""].filter(Boolean).join(". "));
    }
  }
  SEM.vecs = await embedAll(texts);
  SEM.ready = true;
  $("semStatus").textContent = "✓ semantic matching active ("+SEM.entities.length+" entity embeddings, in-browser)";
}
async function embedAll(texts){
  const out=[];
  for(const t of texts){ const r=await SEM.pipe(t,{pooling:"mean",normalize:true}); out.push(Array.from(r.data)); }
  return out;
}
const cosSim=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0); // vectors are normalized

async function semCandidates(colName, samples){
  if(!SEM.ready) return [];
  const [v]=await embedAll([colName+". example values: "+(samples||[]).join(", ")]);
  return SEM.entities
    .map((e,i)=>({id:e.id,kind:e.kind,sim:cosSim(v,SEM.vecs[i])}))
    .filter(x=>x.sim>=0.45)
    .sort((a,b)=>b.sim-a.sim).slice(0,5)
    .map(x=>({id:x.id,kind:x.kind,conf:Math.min(0.3+0.6*x.sim,0.85),how:"cosine "+x.sim.toFixed(2),term:colName,sem:true}));
}

/* merge lexical + semantic candidate lists (agreement bonus) */
async function candidatesFor(prof){
  const lex=lexCandidates(prof.name);
  const sem=await semCandidates(prof.name, prof.samples);
  const map=new Map();
  for(const c of lex) map.set(c.id,{...c});
  for(const s of sem){
    const p=map.get(s.id);
    if(p){ p.conf=Math.min(0.97,Math.max(p.conf,s.conf)+0.05); p.how+=" + semantic agrees ("+s.how+")"; }
    else map.set(s.id,{...s});
  }
  return [...map.values()].sort((a,b)=>b.conf-a.conf);
}

/* ---------------------- generic (Class, Individual) restrictions ---------------------- */
function assertedType(indId){ const t=(ONT.individuals[indId]||{}).types||[]; return t[0]||null; }
function typeOk(indId, classId){ // individual's asserted or inferred types include classId?
  const ts=(ONT.individuals[indId]||{}).types||[];
  return ts.some(t=>t===classId||ancestors(t).includes(classId));
}
function indsForClass(classId){ // individuals that are instances of classId (asserted or via subclass inference)
  const ids=Object.keys(ONT.individuals);
  return classId? ids.filter(i=>typeOk(i,classId)) : ids;
}
const indOption=(id,sel)=>`<option value="${id}" ${id===sel?"selected":""}>${esc(lbl(id))} : ${esc(lbl(assertedType(id)||"?"))}</option>`;
/* AI proposal: scan the column's cell values for ontology individuals (key-value data models) */
function valueRestrictions(prof){
  const out=[];
  for(const [iid,ind] of Object.entries(ONT.individuals)){
    const names=[ind.label, ...(ind.syns||[]), ind.longName].filter(Boolean).map(norm);
    const hit=(prof.distincts||[]).find(v=>names.includes(norm(v)));
    if(hit) out.push({classId:assertedType(iid), indId:iid, why:`cell value “${hit}” matches individual ${ind.label} : ${lbl(assertedType(iid))}`});
  }
  return out;
}
function mergeRestr(restr, adds, sources){
  for(const a of adds){
    if(!restr.some(r=>r.indId===a.indId && r.classId===a.classId)){
      restr.push({classId:a.classId, indId:a.indId});
      sources.push({src:a.sem?"semantic":"heuristic", txt:a.why});
    }
  }
}

/* semantic value matching: embed distinct cell values, compare to individual embeddings */
const VALCACHE=new Map();
async function semValueRestrictions(prof){
  if(!SEM.ready) return [];
  const inds=SEM.entities.map((e,i)=>({id:e.id,kind:e.kind,vec:SEM.vecs[i]})).filter(e=>e.kind==="individual");
  if(!inds.length) return [];
  const vals=(prof.distincts||[]).filter(v=>v.length>=2 && v.length<=60 && !/^\d+([.,]\d+)?$/.test(v)).slice(0,25);
  const out=[];
  for(const v of vals){
    let vec=VALCACHE.get(v);
    if(!vec){ [vec]=await embedAll([v]); VALCACHE.set(v,vec); }
    for(const ind of inds){
      const sim=cosSim(vec,ind.vec);
      if(sim>=0.6) out.push({classId:assertedType(ind.id), indId:ind.id, sem:true,
        why:`cell value “${v}” ≈ individual ${lbl(ind.id)} : ${lbl(assertedType(ind.id))} (semantic, cosine ${sim.toFixed(2)})`});
    }
  }
  return out;
}

/* ---------------------- proposal engine ---------------------- */
let DEFAULT_KEYS=[]; // selected in the 🔑 multiselect (from CSV columns)
function guessKeys(headers){
  const keys=[];
  const study=headers.find(x=>/^study$/i.test(x)); if(study) keys.push(study);
  const site=headers.find(x=>/^site ?id$/i.test(x)); if(site) keys.push(site);
  return keys.length?keys:headers.slice(0,1);
}
function keyCols(){ return DEFAULT_KEYS.length? [...DEFAULT_KEYS] : guessKeys(STATE.headers); }
function renderDkList(){
  $("dkList").innerHTML = STATE.headers.length
    ? STATE.headers.map(h=>`<label class="ddopt"><input type="checkbox" value="${esc(h)}" ${DEFAULT_KEYS.includes(h)?"checked":""}> ${esc(h)}</label>`).join("")
    : '<span class="muted">load a CSV first</span>';
  $("dkLabel").textContent=DEFAULT_KEYS.join(", ")||"—";
}
$("dkList").addEventListener("change",()=>{
  DEFAULT_KEYS=[...$("dkList").querySelectorAll("input:checked")].map(x=>x.value);
  $("dkLabel").textContent=DEFAULT_KEYS.join(", ")||"—";
});

async function proposeForColumn(prof){
  const sources=[], restr=[], notes=[];
  let classId=null, propId=null, indId=null, newInd=null, conf=0, plannedActual=prof.planned?"planned":prof.actual?"actual":null;

  if(prof.isJunk || prof.type==="empty")
    return {col:prof.name, status:"ignored", conf:0, sources:[], restr:[], note: prof.type==="empty"?"column is empty":"unnamed/junk column", keys:keyCols()};

  const lex=await candidatesFor(prof);
  const topProp=lex.find(c=>c.kind==="dataProperty");
  const topClass=lex.find(c=>c.kind==="class");
  // OWL type check: only individuals typed (a subclass of) the milestone-name class may fill that slot
  const isMsName=id=>CFG.msNameTop ? (ONT.individuals[id]?.types||[]).some(t=>t===CFG.msNameTop||t===CFG.msName||ancestors(t).includes(CFG.msNameTop)) : true;
  const topInd=lex.find(c=>c.kind==="individual" && isMsName(c.id));

  /* --- Template 1: milestone/event date column (only if the loaded ontology has the pattern) --- */
  const msKeyword = MS_KEYWORDS.some(k=>norm(prof.name).includes(k));
  if(prof.type==="excel-date" && (msKeyword || prof.dateWord) && CFG.milestone && CFG.dateProp){
    classId=CFG.siteMilestone||CFG.milestone; propId=CFG.dateProp; conf=0.62;
    sources.push({src:"heuristic",txt:`date-typed column with event keyword → ${lbl(classId)} + ${lbl(propId)} template`});
    if(CFG.studyKey) restr.push({classId:CFG.studyKey.cls, propId:CFG.studyKey.prop});
    if(CFG.siteKey)  restr.push({classId:CFG.siteKey.cls,  propId:CFG.siteKey.prop});
    if(topInd && topInd.conf>=0.6){
      indId=topInd.id; conf=Math.max(conf,0.6+0.3*topInd.conf);
      sources.push({src:topInd.sem?"semantic":"lexical",txt:`'${topInd.term}' ≈ individual ${lbl(topInd.id)} (${topInd.how}, ${Math.round(topInd.conf*100)}%)`});
      restr.push({classId:assertedType(topInd.id)||CFG.msName, indId:topInd.id}); // asserted type, e.g. SIV : Site Milestone Name
    } else if(CFG.msName){
      const guess = prof.name.replace(/\(.*?\)/g," ").replace(/[\/|]/g," ").replace(/\b(planned|actual|date|completion)\b/gi," ").replace(/\s+/g," ").trim();
      newInd={label:guess||prof.name, classId:CFG.msName};
      restr.push({classId:CFG.msName, newInd:true});
      notes.push(`ontology gap: no ${lbl(CFG.msName)} individual matches “${guess||prof.name}” — suggest adding one.`);
      conf=Math.max(conf-0.07,0.4);
    }
    if(plannedActual==="planned" && CFG.planning && CFG.planningInd) restr.push({classId:CFG.planning, indId:CFG.planningInd});
    if(plannedActual==="actual" && CFG.actualGen){ restr.push({classId:CFG.actualGen}); notes.push(`'actual' modeled via wasGeneratedBy union class ${CFG.actualGen}.`); }
    sources.push({src:"owl",txt:`validated: ${lbl(classId)} subclass chain carries (${lbl(propId)} some xsd:date) and the occurs-in / has-name restrictions of the loaded ontology`});
    conf=Math.min(conf+0.08,0.93); // OWL validation bonus: value type matches property range
    mergeRestr(restr, [...valueRestrictions(prof), ...await semValueRestrictions(prof)], sources);
    return {col:prof.name,status:"review",classId,propId,indId,newInd,restr,plannedActual,conf,sources,note:notes.join(" "),keys:keyCols()};
  }

  /* --- Template 2: direct lexical class+property --- */
  if(topClass && topClass.conf>=0.55){
    classId=topClass.id;
    sources.push({src:topClass.sem?"semantic":"lexical",txt:`'${topClass.term}' ≈ class ${lbl(topClass.id)} (${topClass.how}, ${Math.round(topClass.conf*100)}%)`});
    conf=topClass.conf*0.9;
    if(topProp && topProp.conf>=0.55){
      propId=topProp.id; conf=Math.max(conf,(topClass.conf+topProp.conf)/2);
      sources.push({src:topProp.sem?"semantic":"lexical",txt:`'${topProp.term}' ≈ property ${lbl(topProp.id)} (${Math.round(topProp.conf*100)}%)`});
    } else {
      // pick a plausible datatype property by range/type — generic lookups over the loaded ontology
      if(prof.type==="excel-date") propId=CFG.dateProp;
      else if(/name/i.test(prof.name)) propId=pickDataProp(/name/i, classId);
      else if(prof.type==="number"||/id|number|code/i.test(prof.name)) propId=pickDataProp(/identifier|\bid\b|number|code/i, classId);
      if(propId) sources.push({src:"heuristic",txt:`property ${lbl(propId)} inferred from value type '${prof.type}'`});
    }
    // OWL validation
    if(propId){
      const p=ONT.dataProperties[propId];
      if(p && p.domain && p.domain!==classId && !ancestors(classId).includes(p.domain))
        notes.push(`⚠ domain check: ${lbl(propId)} has domain ${lbl(p.domain)}, but class is ${lbl(classId)}.`);
      else { sources.push({src:"owl",txt:"domain/range check passed"}); conf=Math.min(conf+0.05,0.95); }
      if(p && p.range==="xsd:date" && prof.type!=="excel-date"){ notes.push("⚠ range is xsd:date but values are not dates."); conf-=0.15; }
    }
    mergeRestr(restr, [...valueRestrictions(prof), ...await semValueRestrictions(prof)], sources);
    return {col:prof.name,status:"review",classId,propId,indId,newInd,restr,plannedActual,conf:Math.max(conf,0.3),sources,note:notes.join(" "),keys:keyCols()};
  }

  /* --- Template 3: property-only match --- */
  if(topProp && topProp.conf>=0.6){
    propId=topProp.id; classId = ONT.dataProperties[propId].domain || null;
    sources.push({src:topProp.sem?"semantic":"lexical",txt:`'${topProp.term}' ≈ property ${lbl(propId)} (${Math.round(topProp.conf*100)}%)`});
    if(classId) sources.push({src:"owl",txt:`class ${lbl(classId)} inferred from property domain`});
    mergeRestr(restr, [...valueRestrictions(prof), ...await semValueRestrictions(prof)], sources);
    return {col:prof.name,status:"review",classId,propId,indId,newInd,restr,plannedActual,conf:topProp.conf*0.85,sources,note:"",keys:keyCols()};
  }

  /* --- unmapped: ontology gap --- */
  return {col:prof.name,status:"unmapped",classId:null,propId:null,restr:[],plannedActual,conf:0,sources:[],
    note:"no matching ontology concept — candidate for ontology extension"+(prof.type==="boolean"?" (boolean flag; no boolean datatype property in ontology)":""),keys:keyCols()};
}

/* ---------------------- seeds + persistence ---------------------- */
function saveLS(){
  try{ localStorage.setItem(LS_KEY, JSON.stringify({fileName:STATE.fileName,
    decisions:STATE.maps.map(m=>({col:m.col,propId:m.propId,status:m.status,classId:m.classId,indId:m.indId,plannedActual:m.plannedActual}))})); }catch(e){}
}
function loadLS(){
  try{ const d=JSON.parse(localStorage.getItem(LS_KEY)||"null");
    if(d && d.fileName===STATE.fileName){
      for(const dec of d.decisions){
        const m=STATE.maps.find(x=>x.col===dec.col && (x.propId===dec.propId||x.classId===dec.classId));
        if(m){ m.status=dec.status; if(dec.classId)m.classId=dec.classId; if(dec.indId)m.indId=dec.indId; }
      }
      return true;
    }
  }catch(e){}
  return false;
}

/* ---------------------- rendering ---------------------- */
function confMeta(c){ return c>=0.85?["High","hi","var(--good)"]:c>=0.6?["Medium","md","var(--mid)"]:["Low","lo","var(--low)"]; }
function badge(s){ const cls=s.src==="lexical"?"b-lex":s.src==="semantic"?"b-sem":s.src==="heuristic"?"b-heu":s.src==="owl"?"b-val":"b-yaml";
  const ico=s.src==="lexical"?"🔤":s.src==="semantic"?"🧠":s.src==="heuristic"?"🧪":s.src==="owl"?"🕸":"📄";
  return `<span class="badge ${cls}" title="${esc(s.txt)}">${ico} ${s.src}</span>`; }

function restrChips(m){
  return m.restr.map(r=>{
    if(r.newInd)
      return `<span class="chip newind">＋ new individual: “${esc(m.newInd?m.newInd.label:"?")}” : ${esc(lbl(r.classId))}</span>`;
    if(r.indId) return `<span class="chip">${esc(lbl(r.classId))} = <b>${esc(lbl(r.indId))}</b></span>`;
    if(r.propId) return `<span class="chip">${esc(lbl(r.classId))} via ${esc(lbl(r.propId))} (key)</span>`;
    return `<span class="chip">${esc(lbl(r.classId))}</span>`;
  }).join("");
}

function render(){
  const el=$("cards"); el.innerHTML="";
  const order={confirmed:1,review:0,unmapped:2,ignored:3};
  const maps=[...STATE.maps].sort((a,b)=>(order[a.status]-order[b.status])||b.conf-a.conf);
  maps.forEach(m=>{
    const i=STATE.maps.indexOf(m);
    const prof=STATE.cols.find(c=>c.name===m.col)||{samples:[],type:"?"};
    const [clab,ccls,ccol]=confMeta(m.conf);
    const pill = m.status==="confirmed"?`<span class="pill ok">confirmed</span>`
      : m.status==="review"?`<span class="pill rev">needs review</span>`
      : m.status==="unmapped"?`<span class="pill un">unmapped</span>`:`<span class="pill">ignored</span>`;
    const mapline = m.classId||m.propId ?
      `<div class="mapline">→ <b>${esc(lbl(m.classId)||"?")}</b> <span class="curie">${esc(m.classId||"")}</span>
        ${m.propId?` · <b>${esc(lbl(m.propId))}</b> <span class="curie">${esc(m.propId)}</span>`:""}
        ${m.plannedActual?` · <span class="chip">${m.plannedActual}</span>`:""}
        <div class="chiprow">${restrChips(m)}<span class="chip keychip">🔑 keys: ${esc((m.keys||[]).join(", ")||"—")}</span></div></div>` : "";
    const card=document.createElement("div");
    card.className="card "+m.status;
    card.innerHTML=`
      <div class="chead">
        ${pill}<span class="colname">${esc(m.col)}</span>
        <span class="samples">${esc(prof.type)} · e.g. ${esc(prof.samples.map(s=>prof.type==="excel-date"&&/^\d+$/.test(s)?excelToISO(+s):s).join(" | ")||"—")}</span>
        ${m.sources.map(badge).join(" ")}
        <span class="confwrap"><span class="confbar"><i style="width:${Math.round(m.conf*100)}%;background:${ccol}"></i></span><span class="conftxt ${ccls}">${clab} ${Math.round(m.conf*100)}%</span></span>
      </div>
      ${mapline}
      ${m.note?`<div class="note">${esc(m.note)}</div>`:""}
      <div class="cbtns">
        ${m.status!=="confirmed"&&(m.classId||m.propId)?`<button data-a="confirm" data-i="${i}" class="primary">✓ Confirm</button>`:""}
        ${m.status!=="ignored"?`<button data-a="ignore" data-i="${i}" class="ghost">✗ Ignore</button>`:`<button data-a="review" data-i="${i}" class="ghost">↩ Restore</button>`}
        ${m.status==="confirmed"?`<button data-a="review" data-i="${i}" class="ghost">↩ Reopen</button>`:""}
      </div>
      <details class="edit" ${m._editOpen?"open":""}><summary>✏️ Edit mapping</summary><div class="editgrid">
        <label>Class</label><select data-e="classId" data-i="${i}">${["", ...Object.keys(ONT.classes)].map(id=>`<option value="${id}" ${id===(m.classId||"")?"selected":""}>${id?esc(lbl(id))+" ("+id+")":"—"}</option>`).join("")}</select>
        <label>Data property</label><select data-e="propId" data-i="${i}">${(()=>{
          const rel=relevantDataProps(m.classId);
          const opts=["",...rel];
          if(m.propId && !rel.includes(m.propId)) opts.push(m.propId); // keep current selection visible, flagged
          return opts.map(id=>`<option value="${id}" ${id===(m.propId||"")?"selected":""}>${id?esc(lbl(id))+" ("+id+")"+(rel.includes(id)?"":" ⚠ not linked to this class"):"—"}</option>`).join("");
        })()}</select>
        <label>Key fields</label><details class="ddmulti inline"><summary><span class="ksel">${esc((m.keys||[]).join(", ")||"— none —")}</span></summary><div class="ddlist">${STATE.headers.map(h=>`<label class="ddopt"><input type="checkbox" data-e="keycb" data-i="${i}" value="${esc(h)}" ${(m.keys||[]).includes(h)?"checked":""}> ${esc(h)}</label>`).join("")}</div></details>
      </div>
      <div class="resedit">
        <b>Restrictions (key–value context)</b>
        <div class="chiprow">${m.restr.length? m.restr.map((r,ri)=>
          `<span class="chip">${esc(lbl(r.classId))}${r.indId?` = <b>${esc(lbl(r.indId))}</b>`:""}${r.propId?` via ${esc(lbl(r.propId))} (key)`:""}${r.newInd&&m.newInd?` = ＋“${esc(m.newInd.label)}” (new)`:""} <button class="chipx" title="remove" data-a="rmres" data-i="${i}" data-r="${ri}">✗</button></span>`).join("") : '<span class="muted">none</span>'}</div>
        <div class="row">
          <select data-role="resClass"><option value="">class (optional)…</option>${Object.keys(ONT.classes).map(id=>`<option value="${id}">${esc(lbl(id))} (${id})</option>`).join("")}</select>
          <select data-role="resInd"><option value="">individual…</option>${Object.keys(ONT.individuals).map(id=>indOption(id,null)).join("")}</select>
          <button class="ghost" data-a="addres" data-i="${i}">＋ Add restriction</button>
        </div>
        <div class="note">Selecting a class filters the individual list to its (inferred) instances; leave the class empty to see all individuals — the asserted class is then used automatically (e.g. SIV : Site Milestone Name). A class without an individual gives a class-only restriction.</div>
      </div></details>`;
    el.appendChild(card);
  });

  // summary + gaps
  const n=s=>STATE.maps.filter(m=>m.status===s).length;
  $("summary").innerHTML = STATE.headers.length?
    `<b>${STATE.headers.length}</b> columns · <span class="hi">✓ ${n("confirmed")} confirmed</span> · <span class="md">⚠ ${n("review")} to review</span> · <span class="lo">${n("unmapped")} unmapped</span> · ${n("ignored")} ignored`:"";
  const gaps=STATE.maps.filter(m=>m.newInd&&m.status!=="ignored");
  const unm=STATE.maps.filter(m=>m.status==="unmapped");
  $("gaps").innerHTML = (gaps.length?`<b>🧩 Ontology gaps — suggested new individuals:</b> ${gaps.map(g=>`<span class="gap">“${esc(g.newInd.label)}” : ${esc(lbl(g.newInd.classId)||"?")} (from column: ${esc(g.col)})</span>`).join("")}<br>`:"")+
    (unm.length?`<b>🚧 No ontology concept found for:</b> ${unm.slice(0,12).map(u=>`<span class="gap">${esc(u.col)}</span>`).join("")}${unm.length>12?" …":""}`:"");
  const has=STATE.maps.some(m=>m.status==="confirmed");
  ["exportYaml","exportR2rml","exportJson"].forEach(id=>$(id).disabled=!has);
  saveLS();
}

$("cards").addEventListener("click",e=>{
  const b=e.target.closest("button[data-a]"); if(!b) return;
  const m=STATE.maps[+b.dataset.i]; if(!m) return;
  const a=b.dataset.a;
  if(a==="rmres"){
    m.restr.splice(+b.dataset.r,1);
    if(!m.restr.some(r=>r.newInd)) m.newInd=null;
    m.sources.push({src:"owl",txt:"restriction removed manually"});
    m._editOpen=true; render(); return;
  }
  if(a==="addres"){
    const det=b.closest("details");
    const rc=det.querySelector('[data-role=resClass]').value||null;
    const ri=det.querySelector('[data-role=resInd]').value||null;
    if(!rc && !ri) return;
    if(ri && rc && !typeOk(ri,rc)){
      alert(`OWL type check: “${lbl(ri)}” is a ${lbl(assertedType(ri))}, not a ${lbl(rc)}. Pick a compatible class or leave the class empty to use the asserted type.`);
      return;
    }
    const cid=rc||assertedType(ri);
    if(m.restr.some(r=>r.classId===cid&&(r.indId||null)===(ri||null))) return; // duplicate
    m.restr.push(ri?{classId:cid,indId:ri}:{classId:cid});
    m.sources.push({src:"owl",txt:`manual restriction: ${lbl(cid)}${ri?" = "+lbl(ri):""}`});
    m._editOpen=true; render(); return;
  }
  m.status=a==="confirm"?"confirmed":a==="ignore"?"ignored":"review";
  m._editOpen=false;
  render();
});
$("cards").addEventListener("change",e=>{
  // restriction class picked → filter the individual dropdown to instances of that class (in place)
  const rc=e.target.closest('select[data-role="resClass"]');
  if(rc){
    const indSel=rc.parentElement.querySelector('select[data-role="resInd"]');
    const keep=indSel.value;
    const ids=indsForClass(rc.value||null);
    indSel.innerHTML='<option value="">'+(rc.value? (ids.length? "individual of "+esc(lbl(rc.value))+"…" : "no individuals of "+esc(lbl(rc.value))) : "individual…")+'</option>'
      + ids.map(id=>indOption(id, ids.includes(keep)?keep:null)).join("");
    return;
  }
  const s=e.target.closest("select[data-e],input[data-e]"); if(!s) return;
  if(!s.dataset.i) return; // resClass/resInd selects are handled by the Add button
  const m=STATE.maps[+s.dataset.i]; const f=s.dataset.e;
  if(f==="keycb"){ // key multiselect: update in place, no full re-render (keeps the dropdown open)
    const dd=s.closest(".ddmulti");
    m.keys=[...dd.querySelectorAll('input[data-e="keycb"]:checked')].map(x=>x.value);
    dd.querySelector(".ksel").textContent=m.keys.join(", ")||"— none —";
    const chip=s.closest(".card").querySelector(".keychip"); if(chip) chip.textContent="🔑 keys: "+(m.keys.join(", ")||"—");
    m._editOpen=true; saveLS(); return;
  }
  m[f]=s.value||null;
  m.sources.push({src:"owl",txt:"manually edited ("+f+")"});
  m._editOpen=true;
  render();
});

/* ---------------------- exports ---------------------- */
function yq(s){ return '"'+String(s).replace(/"/g,'\\"')+'"'; }
function exportYAML(){
  const L=[];
  L.push("# Generated by Ontology Mapping Studio — "+new Date().toISOString().slice(0,10));
  L.push("# Source ontology: "+(ONT.source_file||"(loaded in browser)")+" · Table: "+(STATE.fileName||"data.csv"));
  L.push('schema_version: "0.1"');
  L.push("");
  L.push("mappings:");
  for(const m of STATE.maps.filter(x=>x.status==="confirmed")){
    L.push("  - source:");
    L.push("      ontology_class:");
    L.push("        rdfs:label: "+yq(lbl(m.classId)));
    L.push("        uri: "+uri(m.classId));
    if(m.propId){
      L.push("        data_property:");
      L.push("          rdfs:label: "+yq(lbl(m.propId)));
      L.push("          uri: "+uri(m.propId));
    }
    if(m.restr.length){
      L.push("      restricted_by:");
      for(const r of m.restr){
        L.push("        - ontology_class:");
        L.push("            rdfs:label: "+yq(lbl(r.classId)));
        L.push("            uri: "+uri(r.classId));
        if(r.propId){
          L.push("            data_property:");
          L.push("              rdfs:label: "+yq(lbl(r.propId)));
          L.push("              uri: "+uri(r.propId));
        }
        if(r.indId){
          L.push("            individual:");
          L.push("              rdfs:label: "+yq(lbl(r.indId)));
          L.push("              uri: "+uri(r.indId));
        }
        if(r.newInd&&m.newInd){
          L.push("            individual:");
          L.push("              rdfs:label: "+yq(m.newInd.label));
          L.push("              uri: TO_BE_CREATED   # ontology gap — add this individual to the ontology");
        }
      }
    }
    L.push("    target:");
    L.push("      database:");
    L.push("        table: "+(STATE.fileName||"data.csv"));
    L.push("        field: "+yq(m.col));
    L.push("      key_fields:");
    for(const k of m.keys) L.push("        - field: "+yq(k));
    L.push("");
  }
  return L.join("\n");
}

function exportR2RML(){
  const tbl=(STATE.fileName||"data.csv").replace(/\.csv$/i,"");
  const L=[];
  L.push("@prefix rr: <http://www.w3.org/ns/r2rml#> .");
  L.push("@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .");
  L.push("# Generated by Ontology Mapping Studio. Works with Morph-KGC (CSV/SQLite) and Ontop (JDBC).");
  L.push("# Note: column names containing spaces are kept verbatim; quote them per your engine's SQL dialect.");
  L.push("");
  let n=0;
  for(const m of STATE.maps.filter(x=>x.status==="confirmed")){
    n++;
    const keys=m.keys.map(k=>"{"+k+"}").join("_");
    L.push(`<#TM_${n}_${m.col.replace(/[^A-Za-z0-9]+/g,"_")}> a rr:TriplesMap ;`);
    L.push(`  rr:logicalTable [ rr:tableName "${tbl}" ] ;`);
    L.push(`  rr:subjectMap [ rr:template "urn:ssu:${keys}:${m.col.replace(/[^A-Za-z0-9]+/g,"_")}" ; rr:class <${uri(m.classId)}> ] ;`);
    const poms=[];
    if(m.propId) poms.push(`  rr:predicateObjectMap [ rr:predicate <${uri(m.propId)}> ; rr:objectMap [ rr:column "${m.col}"${ONT.dataProperties[m.propId]&&ONT.dataProperties[m.propId].range==="xsd:date"?' ; rr:datatype xsd:date':''} ] ]`);
    for(const r of m.restr){
      if(r.indId){ const pred=CFG.hasNameProp?uri(CFG.hasNameProp):"urn:x-mappingstudio:hasContext";
        poms.push(`  rr:predicateObjectMap [ rr:predicate <${pred}> ; rr:objectMap [ rr:constant <${uri(r.indId)}> ] ]  # context: ${lbl(r.classId)} = ${lbl(r.indId)}`); }
      else if(r.propId){ const ki=m.restr.filter(x=>x.propId).indexOf(r); const keyCol=m.keys[ki]||m.keys[0];
        poms.push(`  rr:predicateObjectMap [ rr:predicate <${uri(r.propId)}> ; rr:objectMap [ rr:column "${keyCol}" ] ]  # context key: ${lbl(r.classId)}`); }
      else if(r.newInd&&m.newInd) poms.push(`  # TODO ontology gap: create individual "${m.newInd.label}" : ${lbl(r.classId)} and add rr:constant here`);
      else poms.push(`  rr:predicateObjectMap [ rr:predicate <http://www.w3.org/ns/prov#wasGeneratedBy> ; rr:objectMap [ rr:template "urn:x-mappingstudio:${(lbl(r.classId)||"ctx").replace(/[^A-Za-z0-9]+/g,"_")}" ] ]  # class-only restriction: ${lbl(r.classId)}`);
    }
    L.push(poms.join(" ;\n")+" .");
    L.push("");
  }
  return L.join("\n");
}

function exportJSONmap(){
  return JSON.stringify({generated:new Date().toISOString(), table:STATE.fileName,
    mappings: STATE.maps.filter(m=>m.status==="confirmed").map(m=>({col:m.col,classId:m.classId,classUri:uri(m.classId),
      propId:m.propId,propUri:m.propId?uri(m.propId):null,plannedActual:m.plannedActual,keys:m.keys,
      restrictions:m.restr.map(r=>({classId:r.classId,classUri:uri(r.classId),propId:r.propId||null,individualId:r.indId||null,individualUri:r.indId?uri(r.indId):null,newIndividual:r.newInd&&m.newInd?m.newInd.label:null})),
      ontologyGap:m.newInd?m.newInd.label:null}))}, null, 2);
}

let currentExport={name:"",text:""};
function showExport(title,name,text){
  currentExport={name,text};
  $("exportPanel").style.display="block";
  $("exportTitle").textContent=title;
  $("exportPre").textContent=text;
  $("exportPanel").scrollIntoView({behavior:"smooth"});
}
$("exportYaml").onclick=()=>showExport("YAML mapping (your schema v0.1)","ontology_mapping.yaml",exportYAML());
$("exportR2rml").onclick=()=>showExport("R2RML mapping (Morph-KGC / Ontop)","ontology_mapping.r2rml.ttl",exportR2RML());
$("exportJson").onclick=()=>showExport("JSON mapping","ontology_mapping.json",exportJSONmap());
$("copyExport").onclick=()=>navigator.clipboard.writeText(currentExport.text);
$("dlExport").onclick=()=>{
  const b=new Blob([currentExport.text],{type:"text/plain"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(b); a.download=currentExport.name; a.click();
  URL.revokeObjectURL(a.href);
};

/* ---------------------- load + run ---------------------- */
function runCSV(text, fileName){
  const {headers,rows}=parseCSV(text);
  if(!headers.length){ $("csvInfo").textContent="Could not parse CSV."; return; }
  STATE={fileName, headers, rows, cols:[], maps:[]};
  STATE.cols=headers.map(h=>profileColumn(h,rows));
  // keep previously chosen default keys that still exist in the new CSV; otherwise guess
  DEFAULT_KEYS=DEFAULT_KEYS.filter(k=>headers.includes(k));
  if(!DEFAULT_KEYS.length) DEFAULT_KEYS=guessKeys(headers);
  renderDkList();
  $("csvInfo").textContent=`${fileName}: ${headers.length} columns · ${rows.length} rows`;
  $("propose").disabled=false;
  $("cards").innerHTML=`<div class="card"><div class="chead"><span class="colname">CSV loaded.</span><span class="muted">Click “⚙️ Propose mappings” to run the pipeline.</span></div></div>`;
}
$("fileInput").addEventListener("change",e=>{
  const f=e.target.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=()=>{ try{ runCSV(r.result,f.name); }catch(err){ showFatal("CSV parsing failed: "+err.message); } };
  r.onerror=()=>showFatal("Could not read the selected file.");
  r.readAsText(f,"utf-8");
});
$("loadSample").onclick=async()=>{
  try{ const t=await (await fetch("sample_data.csv")).text(); runCSV(t,"sample_data.csv"); }
  catch(e){ $("csvInfo").textContent="Sample fetch failed (open via http/GitHub Pages, not file://)."; }
};
async function runProposals(){
  if(!ONT){ showFatal("Cannot propose mappings: no ontology loaded — use “🦉 Load ontology” first."); return; }
  const btn=$("propose"); btn.disabled=true; const old=btn.textContent;
  STATE.maps=[];
  for(let i=0;i<STATE.cols.length;i++){
    btn.textContent=`⚙️ Proposing… ${i+1}/${STATE.cols.length}`;
    STATE.maps.push(await proposeForColumn(STATE.cols[i]));
  }
  const restored=loadLS();
  render();
  btn.textContent=old; btn.disabled=false;
  if(restored) $("csvInfo").textContent+=" · previous decisions restored";
}
$("propose").onclick=runProposals;
$("resetAll").onclick=async()=>{ try{localStorage.removeItem(LS_KEY);}catch(e){} if(STATE.cols.length) await runProposals(); };
$("semBtn").onclick=initSemantic;

/* =========================================================================
   GENERIC ONTOLOGY LOADING — parse any .ttl / .rdf / .owl in the browser
   Turtle/N-Triples via N3.js (CDN); RDF/XML via DOMParser.
   ========================================================================= */
const RDFNS="http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFSNS="http://www.w3.org/2000/01/rdf-schema#";
const OWLNS="http://www.w3.org/2002/07/owl#";
const XSDNS="http://www.w3.org/2001/XMLSchema#";
const SKOSNS="http://www.w3.org/2004/02/skos/core#";
const OBOIO="http://www.geneontology.org/formats/oboInOwl#";
const OBO="http://purl.obolibrary.org/obo/";
const LABELP=[RDFSNS+"label", SKOSNS+"prefLabel", OBO+"NCIT_P108"];
const SYNP=[OBOIO+"hasExactSynonym", OBOIO+"hasRelatedSynonym", SKOSNS+"altLabel", OBO+"IAO_0000118", OBO+"IAO_0000111"];
const DEFP=[OBO+"IAO_0000115", SKOSNS+"definition", RDFSNS+"comment"];

function parseTurtle(text){
  if(typeof N3==="undefined") throw new Error("Turtle parser (n3.min.js) not loaded from CDN");
  const tid=t=>t.termType==="BlankNode"?"_:"+t.value:t.value;
  return new N3.Parser().parse(text).map(q=>({
    s:tid(q.subject), p:q.predicate.value,
    o:q.object.termType==="Literal"?q.object.value:tid(q.object),
    lit:q.object.termType==="Literal"
  }));
}
function parseRdfXml(text){
  const doc=new DOMParser().parseFromString(text,"application/xml");
  if(doc.getElementsByTagName("parsererror").length) throw new Error("not well-formed XML");
  const triples=[]; let bn=0;
  const rattr=(el,ln)=>el.getAttributeNS(RDFNS,ln)||el.getAttribute("rdf:"+ln);
  function nodeEl(el){
    let s=rattr(el,"about"); const rid=rattr(el,"ID"); const nid=rattr(el,"nodeID");
    if(!s&&rid) s="#"+rid;
    if(!s&&nid) s="_:"+nid;
    if(!s) s="_:gen"+(bn++);
    const tU=(el.namespaceURI||"")+el.localName;
    if(tU!==RDFNS+"Description") triples.push({s,p:RDFNS+"type",o:tU,lit:false});
    for(const ch of el.children){
      const p=(ch.namespaceURI||"")+ch.localName;
      const res=rattr(ch,"resource"), cnid=rattr(ch,"nodeID");
      if(res) triples.push({s,p,o:res,lit:false});
      else if(cnid) triples.push({s,p,o:"_:"+cnid,lit:false});
      else if(ch.children.length){ for(const sub of ch.children){ triples.push({s,p,o:nodeEl(sub),lit:false}); } }
      else { const txt=(ch.textContent||"").trim(); if(txt) triples.push({s,p,o:txt,lit:true}); }
    }
    return s;
  }
  for(const el of doc.documentElement.children) nodeEl(el);
  return triples;
}

/* ---- CURIE-ish ids from URIs, with stable per-namespace prefixes ---- */
const NSPREF={[RDFSNS]:"rdfs",[OWLNS]:"owl",[SKOSNS]:"skos",[XSDNS]:"xsd",
  "https://schema.org/":"schema","http://schema.org/":"schema",
  "http://www.w3.org/ns/prov#":"prov","http://www.w3.org/2006/time#":"time"};
function makeIdFactory(){
  const nsCache={}, used=new Set(); let nsn=0;
  return function makeId(u){
    if(u.startsWith(OBO)){ const loc=u.slice(OBO.length); const i=loc.indexOf("_");
      return i>0? loc.slice(0,i)+":"+loc.slice(i+1) : "obo:"+loc; }
    const cut=Math.max(u.lastIndexOf("#"),u.lastIndexOf("/"))+1;
    const ns=u.slice(0,cut), loc=u.slice(cut)||u;
    let pfx=NSPREF[ns]||nsCache[ns];
    if(!pfx){
      const segs=ns.replace(/[#/]+$/,"").split(/[/#]/).filter(Boolean);
      let guess=(segs.reverse().find(x=>/[a-zA-Z]{2,}/.test(x)&&!/^v?\d+$/.test(x))||("ns"+(++nsn))).replace(/[^A-Za-z0-9_-]/g,"");
      if(/usdm/i.test(ns)) guess="usdm";
      while(Object.values(nsCache).includes(guess)) guess+="_";
      nsCache[ns]=pfx=guess;
    }
    let id=pfx+":"+loc, n=2;
    while(used.has(id)) id=pfx+":"+loc+"~"+(n++);
    used.add(id);
    return id;
  };
}

/* ---- build the internal ontology model from triples ---- */
function buildOnt(triples, sourceName){
  const by=new Map();
  for(const t of triples){ if(!by.has(t.s)) by.set(t.s,[]); by.get(t.s).push(t); }
  const P=(s,p)=>(by.get(s)||[]).filter(t=>t.p===p);
  const vals=(s,p)=>P(s,p).map(t=>t.o);
  const firstLit=(s,ps)=>{ for(const p of ps){ const t=P(s,p).find(x=>x.lit); if(t) return t.o; } return null; };
  const allLits=(s,ps)=>{ const out=[]; for(const p of ps) for(const t of P(s,p)) if(t.lit) out.push(t.o); return [...new Set(out)]; };

  const makeId=makeIdFactory();
  const idOf=new Map();        // uri -> id
  const O={source_file:sourceName, classes:{}, dataProperties:{}, objectProperties:{}, individuals:{}};
  const xsdShort=u=>u.startsWith(XSDNS)?"xsd:"+u.slice(XSDNS.length):null;
  const named=u=>u && !u.startsWith("_:") && !xsdShort(u);

  function register(u,pool,extra){
    if(idOf.has(u)){ const id=idOf.get(u); return id; }
    const id=makeId(u); idOf.set(u,id);
    const label=firstLit(u,LABELP);
    const loc=u.slice(Math.max(u.lastIndexOf("#"),u.lastIndexOf("/"))+1);
    pool[id]={uri:u, label:label||loc||id, unlabeled:!label,
      syns:allLits(u,SYNP), def:firstLit(u,DEFP)||"", ...extra};
    return id;
  }
  const ensureClass=u=>{ if(idOf.has(u)) return idOf.get(u);
    return register(u,O.classes,{parents:[],restr:[]}); };

  // pass 1: declared entities
  const typesOf=s=>vals(s,RDFNS+"type");
  for(const s of by.keys()){
    if(!named(s)) continue;
    const ts=typesOf(s);
    if(ts.includes(OWLNS+"Class")||ts.includes(RDFSNS+"Class")) ensureClass(s);
  }
  for(const s of by.keys()){
    if(!named(s)) continue;
    const ts=typesOf(s);
    if(ts.includes(OWLNS+"DatatypeProperty")) register(s,O.dataProperties,{});
    else if(ts.includes(OWLNS+"ObjectProperty")) register(s,O.objectProperties,{});
  }
  for(const s of by.keys()){
    if(!named(s)) continue;
    if(typesOf(s).includes(OWLNS+"NamedIndividual")) register(s,O.individuals,{types:[]});
  }

  // pass 2: details
  const idc=u=>idOf.get(u);
  for(const [id,c] of Object.entries(O.classes)){
    const u=c.uri;
    for(const o of vals(u,RDFSNS+"subClassOf")){
      if(named(o)) c.parents.push(ensureClass(o));
      else if(o.startsWith("_:")){ // owl:Restriction bnode
        const onP=vals(o,OWLNS+"onProperty").find(named);
        if(!onP) continue;
        const some=vals(o,OWLNS+"someValuesFrom")[0], only=vals(o,OWLNS+"allValuesFrom")[0],
              onC=vals(o,OWLNS+"onClass")[0],
              qc=firstLit(o,[OWLNS+"qualifiedCardinality",OWLNS+"cardinality",OWLNS+"minQualifiedCardinality"]);
        const fillerU=some||only||onC; if(!fillerU) continue;
        const filler=xsdShort(fillerU)||(named(fillerU)?ensureClass(fillerU):null); if(!filler) continue;
        const pid=idc(onP)||register(onP, O.objectProperties,{});
        c.restr.push({p:pid, kind: qc?("exactly "+qc):(only?"only":"some"), filler});
      }
    }
    c.parents=[...new Set(c.parents)].filter(p=>p!==id);
  }
  for(const pool of [O.dataProperties,O.objectProperties]){
    const isData=pool===O.dataProperties;
    for(const [id,p] of Object.entries(pool)){
      const u=p.uri, ts=typesOf(u);
      const dom=vals(u,RDFSNS+"domain").find(named); if(dom) p.domain=ensureClass(dom);
      const rng=vals(u,RDFSNS+"range").find(o=>named(o)||xsdShort(o));
      if(rng) p.range=xsdShort(rng)||(isData?rng:ensureClass(rng));
      const inv=vals(u,OWLNS+"inverseOf").find(named); if(inv&&idc(inv)) p.inverse=idc(inv);
      const sup=vals(u,RDFSNS+"subPropertyOf").find(named); if(sup&&idc(sup)) p.sub=idc(sup);
      if(ts.includes(OWLNS+"TransitiveProperty")) p.transitive=true;
      if(ts.includes(OWLNS+"FunctionalProperty")) p.functional=true;
    }
  }
  for(const [id,ind] of Object.entries(O.individuals)){
    const u=ind.uri;
    ind.types=vals(u,RDFNS+"type").filter(o=>named(o)&&o!==OWLNS+"NamedIndividual").map(ensureClass);
    // literal assertions on the individual become searchable names (e.g. Long Name "Site Initiation Visit")
    for(const t of (by.get(u)||[])){
      if(t.lit && !LABELP.includes(t.p) && !DEFP.includes(t.p) && t.o.length>=2 && t.o.length<=80){
        if(!ind.longName) ind.longName=t.o;
        if(!ind.syns.includes(t.o)) ind.syns.push(t.o);
      }
    }
  }
  return O;
}

/* ---- resolve optional well-known concepts (clinical demo pattern) by URI, generic fallbacks ---- */
function resolveCFG(){
  const byUri={};
  for(const pool of [ONT.classes,ONT.dataProperties,ONT.objectProperties,ONT.individuals])
    for(const [id,e] of Object.entries(pool)) byUri[e.uri]=id;
  const NV="http://www.semanticweb.org/schaaar2/ontologies/2026/7/ClinOps-Core/";
  const g=u=>byUri[u]||null;
  CFG={
    milestone:g(NV+"NV_C0028"), siteMilestone:g(NV+"NV_C0042"),
    msNameTop:g(NV+"NV_C0040"), msName:g(NV+"NV_C0047"),
    planning:g(NV+"NV_C0065"), actualGen:g(OBO+"NCIT_C16203"),
    hasNameProp:g(NV+"NV_P0102"),
    dateProp:g("http://www.w3.org/2006/time#inXSDDate"),
    studyKey:(g(OBO+"NCIT_C15206")&&g(NV+"NV_D0091"))?{cls:g(OBO+"NCIT_C15206"),prop:g(NV+"NV_D0091")}:null,
    siteKey:(g(OBO+"NCIT_C83100")&&g(NV+"NV_D0090"))?{cls:g(OBO+"NCIT_C83100"),prop:g(NV+"NV_D0090")}:null,
    planningInd:null
  };
  // generic fallbacks for foreign ontologies
  if(!CFG.dateProp) CFG.dateProp=Object.keys(ONT.dataProperties).find(id=>/^xsd:date/.test(ONT.dataProperties[id].range||""))||null;
  if(!CFG.milestone) CFG.milestone=Object.keys(ONT.classes).find(id=>/milestone|event\b/i.test(ONT.classes[id].label))||null;
  if(CFG.planning) CFG.planningInd=Object.keys(ONT.individuals).find(id=>(ONT.individuals[id].types||[]).includes(CFG.planning))||null;
}
/* data properties applicable to a class: rdfs:domain = class or ancestor,
   OR used in an own/inherited owl:Restriction, plus their sub-/super-properties */
function relevantDataProps(classId){
  const all=Object.keys(ONT.dataProperties);
  if(!classId||!ONT.classes[classId]) return all;
  const line=[classId,...ancestors(classId)];
  const set=new Set();
  for(const id of all){
    const d=ONT.dataProperties[id].domain;
    if(d && line.includes(d)) set.add(id);
  }
  for(const c of line)
    for(const r of (ONT.classes[c].restr||[]))
      if(ONT.dataProperties[r.p]) set.add(r.p);
  let grew=true; // close over sub/super-property links
  while(grew){ grew=false;
    for(const id of all){ if(set.has(id)) continue;
      const sub=ONT.dataProperties[id].sub;
      if((sub&&set.has(sub)) || [...set].some(s=>ONT.dataProperties[s]&&ONT.dataProperties[s].sub===id)){ set.add(id); grew=true; }
    }
  }
  return set.size? [...set] : all; // nothing linked → don't leave the user with an empty list
}

function pickDataProp(re, classId){
  const ids=Object.keys(ONT.dataProperties);
  // prefer a property whose domain fits the class
  return ids.find(id=>re.test(ONT.dataProperties[id].label)&&ONT.dataProperties[id].domain&&classId&&(ONT.dataProperties[id].domain===classId||ancestors(classId).includes(ONT.dataProperties[id].domain)))
      || ids.find(id=>re.test(ONT.dataProperties[id].label))||null;
}

function setOntology(ont){
  ONT=ont; resolveCFG(); VALCACHE.clear();
  STATE.maps=[]; if($("cards")) $("cards").innerHTML="";
  const n=o=>Object.keys(o).length;
  $("ontInfo").textContent=`✓ ${ont.source_file}: ${n(ont.classes)} classes · ${n(ont.dataProperties)} data props · ${n(ont.objectProperties)} object props · ${n(ont.individuals)} individuals`;
  console.log("ontology loaded:",ont.source_file,n(ont.classes),"classes; CFG:",JSON.stringify(Object.fromEntries(Object.entries(CFG).filter(([k,v])=>v))));
  if(STATE.cols.length) $("propose").disabled=false;
  if(SEM.pipe) embedOntology(); // re-embed entities for the new ontology (async, fire & forget)
}
function loadOntologyText(text,name){
  const t=text.trimStart();
  const triples = (t.startsWith("<?xml")||t.startsWith("<rdf:RDF")||t.startsWith("<RDF")||(/\.(rdf|owl|xml|rdfs)$/i.test(name)&&t.startsWith("<")))
    ? parseRdfXml(text) : parseTurtle(text);
  const ont=buildOnt(triples,name);
  if(!Object.keys(ont.classes).length && !Object.keys(ont.dataProperties).length)
    throw new Error("no OWL classes or properties found in "+name);
  setOntology(ont);
}
$("ontInput").addEventListener("change",e=>{
  const f=e.target.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=()=>{ try{ loadOntologyText(r.result,f.name); }catch(err){ showFatal("Ontology parsing failed ("+f.name+"): "+err.message); } };
  r.onerror=()=>showFatal("Could not read the ontology file.");
  r.readAsText(f,"utf-8");
});

(async function boot(){
  if(typeof N3==="undefined") showFatal("n3.min.js (Turtle parser) did not load from the CDN — .ttl parsing unavailable; RDF/XML (.owl/.rdf) still works.");
  $("csvInfo").textContent="load an ontology and a CSV to start";
  try{ // optional bundled demo ontology — delete sample_ontology.ttl from the repo to disable
    const r=await fetch("sample_ontology.ttl");
    if(!r.status||r.status<400){ const t=await r.text();
      if(t.trim().startsWith("@prefix")){ loadOntologyText(t,"sample_ontology.ttl"); $("ontInfo").textContent+=" (bundled demo)"; } }
  }catch(e){ /* no bundled demo present — fine */ }
})();
