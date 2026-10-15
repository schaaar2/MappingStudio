/* =========================================================================
   core.js — shared engine for Mapping Studio (index.html) and Data Chat (chat.html)
   Ontology parsing (.ttl via N3.js, .rdf/.owl via DOMParser), model building,
   lexical + semantic (all-MiniLM-L6-v2) matching, OWL helpers, CSV parsing.
   Load AFTER n3.min.js and BEFORE app.js / chat.js.
   ========================================================================= */
"use strict";
window.__CORE_LOADED__ = true;
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

const VALCACHE=new Map();

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


/* parse an ontology file's text into the internal model (throws on failure) */
function parseOntology(text,name){
  const t=text.trimStart();
  const triples = (t.startsWith("<?xml")||t.startsWith("<rdf:RDF")||t.startsWith("<RDF")||(/\.(rdf|owl|xml|rdfs)$/i.test(name)&&t.startsWith("<")))
    ? parseRdfXml(text) : parseTurtle(text);
  const ont=buildOnt(triples,name);
  if(!Object.keys(ont.classes).length && !Object.keys(ont.dataProperties).length)
    throw new Error("no OWL classes or properties found in "+name);
  return ont;
}
