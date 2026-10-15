/* =========================================================================
   Ontology Mapping Studio — maps CSV columns to OWL ontology concepts
   Pipeline: lexical match → value profiling heuristics → OWL validation
   → human confirmation → YAML / R2RML / JSON export.
   Everything runs client-side; no data leaves the browser.
   ========================================================================= */
"use strict";
window.__APP_LOADED__ = true;   // checked by index.html to detect a missing/404 app.js
if(!window.__CORE_LOADED__){ document.body.insertAdjacentHTML("afterbegin",
  '<div style="background:#fdecea;border:1px solid #b3433b;color:#7a2d28;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:13px">⚠ <b>core.js did not load.</b> It must sit next to index.html (exact lowercase name).</div>'); throw new Error("core.js missing"); }

let STATE = { fileName:null, headers:[], rows:[], cols:[], maps:[] };
const LS_KEY = "ontology-mapping-studio-v1";

/* ---------------------- generic (Class, Individual) restrictions ---------------------- */
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

function setOntology(ont){
  ONT=ont; resolveCFG(); VALCACHE.clear();
  STATE.maps=[]; if($("cards")) $("cards").innerHTML="";
  const n=o=>Object.keys(o).length;
  $("ontInfo").textContent=`✓ ${ont.source_file}: ${n(ont.classes)} classes · ${n(ont.dataProperties)} data props · ${n(ont.objectProperties)} object props · ${n(ont.individuals)} individuals`;
  console.log("ontology loaded:",ont.source_file,n(ont.classes),"classes; CFG:",JSON.stringify(Object.fromEntries(Object.entries(CFG).filter(([k,v])=>v))));
  if(STATE.cols.length) $("propose").disabled=false;
  if(SEM.pipe) embedOntology(); // re-embed entities for the new ontology (async, fire & forget)
}
function loadOntologyText(text,name){ setOntology(parseOntology(text,name)); }
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
