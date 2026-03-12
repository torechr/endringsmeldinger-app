import { useState, useRef, useEffect } from "react";
import * as XLSX from "xlsx";

/* ═══════════════════════════════════════════════════════════
   KONFIG
═══════════════════════════════════════════════════════════ */
const NVDB_PORTAL  = "https://nvdb-vegnett-og-objektdata.atlas.vegvesen.no";
const VEGKART_OBJ  = (objId, typeId) => `https://vegkart.atlas.vegvesen.no/#valgt:${objId}:${typeId}`;
const VEGKART_TYPE = "https://vegkart.atlas.vegvesen.no/#vegobjekter/";
const EPOST_TITTEL = "Endringer objekter V2-liste - utkast til gjennomgang byggemøte";

/* ═══════════════════════════════════════════════════════════
   V4 — PARSER OG DIFF
═══════════════════════════════════════════════════════════ */
function parseV4Xlsx(buffer) {
  const wb = XLSX.read(buffer, {type:"array",cellDates:true});
  const SKIP = ["Oversikt"];
  const meta = {};
  const objekttyper = [];

  for (const arknavn of wb.SheetNames) {
    if (SKIP.includes(arknavn)) continue;
    const ws = wb.Sheets[arknavn];
    const alle = XLSX.utils.sheet_to_json(ws, {header:1, defval:null});
    if (!alle || alle.length < 9) continue;

    // Meta fra rad 3-4 (første ark)
    if (!meta.omrade) {
      for (let i=0; i<8; i++) {
        const s = String(alle[i]?.[0] ?? "");
        if (s.startsWith("Område:")) meta.omrade = s.replace("Område:","").trim();
        if (s.startsWith("Gyldighetsdato:")) {
          const m1=s.match(/Gyldighetsdato:\s*(\S+)/), m2=s.match(/Utskriftsdato:\s*(\S+)/);
          if(m1) meta.gyldighetsdato=m1[1].trim();
          if(m2) meta.utskriftsdato=m2[1].trim();
        }
        if (s.startsWith("Rapporttype:")) meta.rapporttype=s.replace("Rapporttype:","").trim();
      }
    }

    const headers = (alle[7]||[]).map(h=>h!=null?String(h).trim():null);
    if (!headers[0] || !headers[0].startsWith("Objekt")) continue;

    const objidIdx   = 0;
    const vegkatIdx  = headers.indexOf("Vegkategori");
    if (vegkatIdx === -1) continue;

    // Finn beste mengdekolonne: Areal > Lengde > Lengde vegnett > Antall
    let mengdeIdx=null, mengdeType=null, mengdeNavn=null;
    for (const [navn,type] of [["Areal","areal"],["Lengde","lengde"],["Lengde vegnett","lengde"],["Antall","antall"]]) {
      const idx = headers.lastIndexOf(navn);
      if (idx !== -1) { mengdeIdx=idx; mengdeType=type; mengdeNavn=navn; break; }
    }

    const objekter = [];
    for (let ri=8; ri<alle.length; ri++) {
      const r = alle[ri];
      if (!r || r[objidIdx]==null) continue;
      const objId = String(r[objidIdx]).trim();
      const vegkat = r[vegkatIdx] ? String(r[vegkatIdx]).trim() : "Ukjent";
      const mengde = mengdeIdx!=null && r[mengdeIdx]!=null ? Number(r[mengdeIdx]) : null;
      // Hent noen nøkkelattributter for "endret"-sammenligning
      const attrs = {};
      for (let ci=0; ci<Math.min(headers.length,30); ci++) {
        if (headers[ci] && r[ci]!=null) attrs[headers[ci]] = r[ci];
      }
      objekter.push({objId, vegkat, mengde, mengdeType, attrs});
    }

    if (objekter.length > 0) {
      // Kortere visningsnavn: "83 - Kum" → "Kum (83)"
      const m = arknavn.match(/^(\d+)\s*-\s*(.+)$/);
      const visning = m ? `${m[2].trim()} (${m[1]})` : arknavn;
      objekttyper.push({arknavn, visning, mengdeNavn, mengdeType, objekter});
    }
  }

  const antallObj = objekttyper.reduce((s,o)=>s+o.objekter.length, 0);
  return { meta, objekttyper, antall: antallObj, filnavn:"" };
}

function kjorV4Diff(grunnlag, navaerende) {
  const endringer = [];
  // Bygg opp map: arknavn → {objId → obj}
  const gMap = {};
  for (const ot of grunnlag.objekttyper) {
    gMap[ot.arknavn] = {};
    for (const o of ot.objekter) gMap[ot.arknavn][o.objId] = o;
  }
  const nMap = {};
  for (const ot of navaerende.objekttyper) {
    nMap[ot.arknavn] = {};
    for (const o of ot.objekter) nMap[ot.arknavn][o.objId] = o;
  }

  // Alle ark fra begge filer
  const alleArk = new Set([
    ...grunnlag.objekttyper.map(o=>o.arknavn),
    ...navaerende.objekttyper.map(o=>o.arknavn),
  ]);

  for (const arknavn of alleArk) {
    const gArk = gMap[arknavn] || {};
    const nArk = nMap[arknavn] || {};
    const m = arknavn.match(/^(\d+)\s*-\s*(.+)$/);
    const visning = m ? `${m[2].trim()} (${m[1]})` : arknavn;
    const objekttypeId = m ? m[1] : null;
    const mengdeType = (grunnlag.objekttyper.find(o=>o.arknavn===arknavn) ||
                        navaerende.objekttyper.find(o=>o.arknavn===arknavn))?.mengdeType || "lengde";

    const alleIds = new Set([...Object.keys(gArk), ...Object.keys(nArk)]);
    for (const objId of alleIds) {
      const g = gArk[objId];
      const n = nArk[objId];
      let endringstype, mengdeFoer=null, mengdeNaa=null, diff=null;

      if (!g && n)       { endringstype="tilgang"; mengdeNaa=n.mengde; diff=n.mengde; }
      else if (g && !n)  { endringstype="avgang";  mengdeFoer=g.mengde; diff=g.mengde!=null?-g.mengde:null; }
      else {
        const mengdeDiff = (n.mengde??0) - (g.mengde??0);
        if (Math.abs(mengdeDiff) > 0.001) {
          endringstype="endret"; mengdeFoer=g.mengde; mengdeNaa=n.mengde; diff=mengdeDiff;
        } else continue; // uendret
      }

      endringer.push({
        objId, arknavn, visning, objekttypeId, endringstype,
        vegkat: (n||g).vegkat,
        mengdeFoer, mengdeNaa, diff, mengdeType,
      });
    }
  }

  // Oppsummering
  const oppsummering = {
    totaltTilgang: endringer.filter(e=>e.endringstype==="tilgang").length,
    totaltAvgang:  endringer.filter(e=>e.endringstype==="avgang").length,
    totaltEndret:  endringer.filter(e=>e.endringstype==="endret").length,
  };

  return { endringer, oppsummering };
}

/* ═══════════════════════════════════════════════════════════
   GLOBAL CSS  — Sora + JetBrains Mono, varm indigo + gul
═══════════════════════════════════════════════════════════ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 16px; }
body { background: #f4f2ff; font-family: 'Sora', system-ui, sans-serif; }

/* ── Animasjoner ── */
@keyframes fadeSlideUp {
  from { opacity:0; transform:translateY(22px); }
  to   { opacity:1; transform:translateY(0); }
}
@keyframes popBounce {
  0%   { opacity:0; transform:scale(0.5) rotate(-8deg); }
  60%  { transform:scale(1.15) rotate(3deg); }
  100% { opacity:1; transform:scale(1) rotate(0deg); }
}
@keyframes stampIn {
  0%   { opacity:0; transform:scale(2.2) rotate(-12deg); }
  50%  { opacity:1; transform:scale(0.92) rotate(3deg); }
  100% { transform:scale(1) rotate(0deg); }
}
@keyframes confettiFall {
  0%   { transform:translateY(-40px) rotate(0deg) scale(1); opacity:1; }
  100% { transform:translateY(110vh)  rotate(900deg) scale(0.6); opacity:0; }
}
@keyframes pulse {
  0%,100% { opacity:1; }
  50%      { opacity:0.45; }
}
@keyframes hpFill {
  from { width: 0; }
}
@keyframes wiggle {
  0%,100% { transform:rotate(0deg); }
  25%      { transform:rotate(-4deg); }
  75%      { transform:rotate(4deg); }
}
@keyframes glowPulse {
  0%,100% { box-shadow: 0 0 0 0 #5b45d644; }
  50%      { box-shadow: 0 0 0 10px #5b45d610; }
}
@keyframes checkDraw {
  from { stroke-dashoffset: 40; }
  to   { stroke-dashoffset: 0; }
}
@keyframes xpCount {
  from { opacity:0; transform:translateY(10px) scale(0.8); }
  to   { opacity:1; transform:translateY(0) scale(1); }
}

/* ── Hjelpeklasser ── */
.anim-in        { animation: fadeSlideUp 0.4s cubic-bezier(0.22,1,0.36,1) both; }
.pop-in         { animation: popBounce   0.45s cubic-bezier(0.34,1.56,0.64,1) both; }
.stamp-in       { animation: stampIn     0.55s cubic-bezier(0.34,1.56,0.64,1) both; }
.anim-in-d1     { animation-delay:0.06s; }
.anim-in-d2     { animation-delay:0.12s; }
.anim-in-d3     { animation-delay:0.18s; }
.anim-in-d4     { animation-delay:0.24s; }

.card {
  background:#fff;
  border-radius:20px;
  border:1.5px solid #e8e4f8;
  box-shadow:0 2px 16px rgba(91,69,214,0.06);
  transition:box-shadow 0.2s, transform 0.2s, border-color 0.2s;
}
.card:hover { box-shadow:0 6px 28px rgba(91,69,214,0.11); }

.card-lift:hover { transform:translateY(-3px); box-shadow:0 10px 32px rgba(91,69,214,0.14); }

.btn {
  display:inline-flex; align-items:center; gap:0.45rem;
  font-family:'Sora',sans-serif; font-weight:700;
  border:none; border-radius:14px; cursor:pointer;
  transition:all 0.15s; outline:none; white-space:nowrap;
}
.btn:disabled { opacity:0.4; cursor:not-allowed; pointer-events:none; }
.btn-primary {
  background:linear-gradient(135deg,#5b45d6,#4433b0);
  color:#fff;
  box-shadow:0 4px 18px rgba(91,69,214,0.38);
}
.btn-primary:hover { filter:brightness(1.1); transform:translateY(-2px); box-shadow:0 8px 24px rgba(91,69,214,0.45); }
.btn-primary:active { transform:translateY(0); }
.btn-secondary {
  background:#fff; color:#5b45d6;
  border:2px solid #d4cdfa;
}
.btn-secondary:hover { border-color:#5b45d6; background:#f4f2ff; }
.btn-ghost { background:transparent; color:#8b80c0; border:1.5px solid #e8e4f8; }
.btn-ghost:hover { background:#f4f2ff; color:#5b45d6; border-color:#c8c0f0; }
.btn-green {
  background:linear-gradient(135deg,#22a06b,#18835a);
  color:#fff;
  box-shadow:0 4px 16px rgba(34,160,107,0.35);
}
.btn-green:hover { filter:brightness(1.1); transform:translateY(-2px); }

.btn-sm  { padding:7px 16px;  font-size:0.78rem; border-radius:10px; }
.btn-md  { padding:11px 24px; font-size:0.88rem; }
.btn-lg  { padding:14px 32px; font-size:1rem;    border-radius:16px; }

.tag {
  display:inline-flex; align-items:center; gap:0.3rem;
  border-radius:30px; padding:4px 12px;
  font-family:'Sora',sans-serif; font-size:0.72rem; font-weight:700;
}

.row-hover { transition:background 0.12s; cursor:pointer; }
.row-hover:hover { background:#f7f5ff !important; }

::-webkit-scrollbar { width:5px; height:5px; }
::-webkit-scrollbar-track { background:#f4f2ff; }
::-webkit-scrollbar-thumb { background:#c8c0f0; border-radius:3px; }
`;

/* ═══════════════════════════════════════════════════════════
   TOKENS
═══════════════════════════════════════════════════════════ */
const BG    = "#f4f2ff";
const WHITE = "#ffffff";
const INK   = "#1a1530";
const SUB   = "#5c5680";
const MUTED = "#9990c4";
const BORD  = "#e8e4f8";

const IND   = "#5b45d6";   // indigo
const INDL  = "#f4f2ff";   // lys indigo
const INDD  = "#4433b0";   // mørk indigo
const GRN   = "#22a06b";   // grønn
const GRNL  = "#e8f8f2";
const AMB   = "#d97706";   // amber/gul
const AMBL  = "#fffbeb";
const RED   = "#dc2626";
const REDL  = "#fff1f0";
const BLU   = "#1d6fb5";
const BLUL  = "#eff6ff";

const FM = "'JetBrains Mono', 'Courier New', monospace";
const FB = "'Sora', system-ui, sans-serif";

const ET = {
  endret:  { label:"Endret",  emoji:"🔄", color:AMB, bg:AMBL, border:"#fde68a" },
  tilgang: { label:"Ny",      emoji:"✅", color:GRN, bg:GRNL, border:"#86efac" },
  avgang:  { label:"Fjernet", emoji:"🗑", color:RED, bg:REDL, border:"#fca5a5" },
};

/* ═══════════════════════════════════════════════════════════
   PARSER  (uendret kjernelogikk)
═══════════════════════════════════════════════════════════ */
function parseV2Xlsx(buffer) {
  const wb = XLSX.read(buffer, { type:"array" });
  const arknavn = wb.SheetNames.find(n=>n==="V2") ?? wb.SheetNames.find(n=>n!=="Oversikt");
  if (!arknavn) throw new Error("Finner ikke V2-arket i filen.");
  const ws = wb.Sheets[arknavn];
  const alle = XLSX.utils.sheet_to_json(ws, { header:1, defval:null });
  if (alle.length < 9) throw new Error("Filen har for få rader.");
  const meta = {};
  for (let i=0;i<7;i++) {
    const c=(alle[i]||[]).find(v=>v!=null); if(!c) continue; const s=String(c);
    if (s.startsWith("Område:")) meta.omrade=s.replace("Område:","").trim();
    if (s.startsWith("Gyldighetsdato:")) {
      const m1=s.match(/Gyldighetsdato:\s*(\S+)/), m2=s.match(/Utskriftsdato:\s*(\S+)/);
      if(m1) meta.gyldighetsdato=m1[1].trim(); if(m2) meta.utskriftsdato=m2[1].trim();
    }
    if (s.startsWith("Rapporttype:")) meta.rapporttype=s.replace("Rapporttype:","").trim();
  }
  const headers=(alle[7]||[]).map(h=>h!=null?String(h).trim():null);
  const kolDef=[];
  for(let i=3;i<headers.length;i++){
    const h=headers[i]; if(!h) continue;
    const m=h.match(/^(.+?)\s*-\s*(Antall|Lengde|Areal)/i);
    if(m) kolDef.push({vegkat:m[1].trim(),type:m[2].toLowerCase(),idx:i});
  }
  const vegkategorier=[...new Set(kolDef.map(k=>k.vegkat))];
  const rader=[];
  for(let ri=8;ri<alle.length;ri++){
    const r=alle[ri]; if(!r) continue;
    const besk=r[0]!=null?String(r[0]).trim():null;
    const typeId=r[1]!=null?String(r[1]).trim():null;
    const navn=r[2]!=null?String(r[2]).trim():null;
    if(!besk||!typeId) continue;
    const verdier={};
    for(const k of kolDef){
      const v=r[k.idx]; const tall=(v!=null&&v!=="") ? parseFloat(String(v).replace(",",".")) : null;
      if(!verdier[k.vegkat]) verdier[k.vegkat]={};
      verdier[k.vegkat][k.type]=(!isNaN(tall)&&tall!=null)?tall:null;
    }
    rader.push({beskrivelse:besk,typeId,typenavn:navn,verdier});
  }
  return {rader,vegkategorier,meta,antall:rader.length};
}
async function parseNVDBFil(fil) {
  const n=fil.name.toLowerCase();
  if(!n.endsWith(".xlsx")&&!n.endsWith(".xls")) throw new Error("Kun XLSX-filer støttes. Last ned fra NVDB-portalen som Excel.");
  return parseV2Xlsx(new Uint8Array(await fil.arrayBuffer()));
}

/* ═══════════════════════════════════════════════════════════
   DIFF
═══════════════════════════════════════════════════════════ */
function kjorDiff(nav, grunn) {
  const mapA=new Map(nav.rader.map(r=>[r.beskrivelse,r]));
  const mapB=new Map(grunn.rader.map(r=>[r.beskrivelse,r]));
  const alleVK=[...new Set([...(nav.vegkategorier||[]),...(grunn.vegkategorier||[])])];
  const liste=[]; let nT=0,nA=0,nE=0;
  const lagDiff=(a,b)=>{
    const d={};
    for(const vk of alleVK){
      const vA=a?.[vk]??{},vB=b?.[vk]??{};
      const typer=new Set([...Object.keys(vA),...Object.keys(vB)]);
      d[vk]={};
      for(const t of typer){
        // Sett null hvis begge sider mangler data for denne typen
        if(vA[t]==null && vB[t]==null){ d[vk][t]=null; continue; }
        d[vk][t]=Math.round(((vA[t]??0)-(vB[t]??0))*100)/100;
      }
    }
    return d;
  };
  const harDiff=d=>{ for(const v of Object.values(d)) for(const x of Object.values(v)) if(Math.abs(x)>0.001) return true; return false; };
  for(const [besk,a] of mapA) if(!mapB.has(besk)){liste.push({beskrivelse:besk,typeId:a.typeId,typenavn:a.typenavn,endringstype:"tilgang",verdierFoer:{},verdierNaa:a.verdier,diff:lagDiff(a.verdier,{}),vegkategorier:alleVK});nT++;}
  for(const [besk,b] of mapB) if(!mapA.has(besk)){liste.push({beskrivelse:besk,typeId:b.typeId,typenavn:b.typenavn,endringstype:"avgang",verdierFoer:b.verdier,verdierNaa:{},diff:lagDiff({},b.verdier),vegkategorier:alleVK});nA++;}
  for(const [besk,a] of mapA){const b=mapB.get(besk);if(!b)continue;const diff=lagDiff(a.verdier,b.verdier);if(!harDiff(diff))continue;liste.push({beskrivelse:besk,typeId:a.typeId,typenavn:a.typenavn,endringstype:"endret",verdierFoer:b.verdier,verdierNaa:a.verdier,diff,vegkategorier:alleVK});nE++;}
  const netto=e=>{for(const t of["lengde","areal","antall"]){let s=0,h=false;for(const vk of Object.values(e.diff??{})){if(vk[t]!=null&&Math.abs(vk[t])>0.001){s+=vk[t];h=true;}}if(h)return Math.abs(s);}return 0;};
  liste.sort((a,b)=>netto(b)-netto(a));
  return {oppsummering:{totaltTilgang:nT,totaltAvgang:nA,totaltEndret:nE},endringsliste:liste,vegkategorier:alleVK};
}

/* ═══════════════════════════════════════════════════════════
   EKSPORT
═══════════════════════════════════════════════════════════ */
function lagCSV(liste,vk){
  const t=["antall","lengde","areal"];
  const h=["Beskrivelse","Typenavn","Endringstype",...vk.flatMap(v=>t.map(x=>`${v} - ${x} (diff)`))].join(";");
  const r=liste.map(e=>[e.beskrivelse,e.typenavn,e.endringstype,...vk.flatMap(v=>t.map(x=>{const val=e.diff?.[v]?.[x];return val!=null?val:"";}))]
    .map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(";"));
  return [h,...r].join("\n");
}
function lastNed(innhold,filnavn,mime){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob(["\uFEFF"+innhold],{type:mime}));
  a.download=filnavn; a.click(); URL.revokeObjectURL(a.href);
}
function primærVerdi(e,side,aktiveVK=null){
  const verdier=side==="foer"?e.verdierFoer:side==="naa"?e.verdierNaa:null;
  const vkListe=aktiveVK&&aktiveVK.length>0 ? aktiveVK : (e.vegkategorier||[]);
  for(const t of["lengde","areal","antall"]){
    let s=0,h=false,harVerdi=false;
    for(const vk of vkListe){
      const v=side==="diff"?e.diff?.[vk]?.[t]:verdier?.[vk]?.[t];
      if(v!=null){s+=v;h=true;if(Math.abs(v)>0.001) harVerdi=true;}
    }
    // Hopp over typen hvis alle verdier er 0 — prøv neste type (f.eks. antall)
    if(h && (harVerdi || side==="diff")) return {sum:Math.round(s*100)/100,type:t};
  }
  // Fallback: returner første type med noen registrerte verdier, selv om sum er 0
  for(const t of["lengde","areal","antall"]){
    let s=0,h=false;
    for(const vk of vkListe){
      const v=side==="diff"?e.diff?.[vk]?.[t]:verdier?.[vk]?.[t];
      if(v!=null){s+=v;h=true;}
    }
    if(h) return {sum:Math.round(s*100)/100,type:t};
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════
   KONFETTI
═══════════════════════════════════════════════════════════ */
function Konfetti() {
  const bits = Array.from({length:28},(_,i)=>({
    id:i,
    x: 2+Math.random()*96,
    delay: Math.random()*1.4,
    dur: 1.6+Math.random()*1.2,
    color: [IND,GRN,AMB,"#ec4899","#f59e0b","#06b6d4"][i%6],
    w: 7+Math.random()*9,
    h: 10+Math.random()*10,
    r: Math.random()>0.5 ? "3px" : "50%",
  }));
  return (
    <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:9999,overflow:"hidden"}}>
      {bits.map(b=>(
        <div key={b.id} style={{
          position:"absolute", left:`${b.x}%`, top:0,
          width:b.w, height:b.h, borderRadius:b.r, background:b.color,
          animation:`confettiFall ${b.dur}s ${b.delay}s ease-in both`,
        }}/>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   HP-BAR  (gamification: HP-stil fremgangsmåler)
═══════════════════════════════════════════════════════════ */
function HPBar({steg, total=4, labels}) {
  const lbls = labels || ["Grunnlag","Nåværende","Bekreft","Ferdig!"];
  const pct = Math.round((steg/total)*100);
  const col = steg===total ? GRN : steg>=total-1 ? AMB : IND;
  return (
    <div style={{padding:"10px 24px", background:WHITE, borderBottom:`1.5px solid ${BORD}`,
      display:"flex", alignItems:"center", gap:"1rem"}}>
      <div style={{fontFamily:FB, fontSize:"0.7rem", fontWeight:700, color:MUTED,
        whiteSpace:"nowrap", minWidth:60}}>
        {steg<total ? `Steg ${steg}/${total}` : "✅ Ferdig!"}
      </div>
      <div style={{flex:1, height:10, background:"#e8e4f8", borderRadius:6, overflow:"hidden", position:"relative"}}>
        <div style={{
          position:"absolute", inset:"0 auto 0 0",
          width:`${pct}%`, background:`linear-gradient(90deg,${col},${col}cc)`,
          borderRadius:6, animation:"hpFill 0.6s cubic-bezier(0.22,1,0.36,1) both",
          boxShadow:`0 0 8px ${col}66`,
        }}/>
      </div>
      <div style={{fontFamily:FM, fontSize:"0.72rem", fontWeight:600, color:col, minWidth:36}}>
        {pct}%
      </div>
      <div style={{display:"flex", gap:"0.5rem"}}>
        {lbls.map((l,i)=>{
          const done=steg>i+1, curr=steg===i+1;
          return (
            <div key={i} style={{display:"flex",alignItems:"center",gap:"0.3rem",
              opacity:done||curr?1:0.35, transition:"opacity 0.3s"}}>
              <div style={{width:8,height:8,borderRadius:"50%",
                background:done?GRN:curr?col:"#c8c0f0",
                boxShadow:curr?`0 0 0 3px ${col}33`:"none",
                transition:"all 0.3s"}}/>
              <span style={{fontFamily:FB,fontSize:"0.65rem",fontWeight:curr?700:500,
                color:done?GRN:curr?col:MUTED}}>{l}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   TOPBAR
═══════════════════════════════════════════════════════════ */
function Topbar({onHjelp, modus, onModus}) {
  return (
    <div style={{background:WHITE,borderBottom:`1.5px solid ${BORD}`,
      padding:"0 24px", height:58, display:"flex",alignItems:"center",
      boxShadow:"0 1px 0 rgba(91,69,214,0.06)"}}>
      <div style={{display:"flex",alignItems:"center",gap:"0.7rem",cursor:modus?"pointer":"default"}}
        onClick={modus?onModus:undefined}>
        <div style={{width:36,height:36,borderRadius:10,
          background:`linear-gradient(135deg,${IND},${INDD})`,
          display:"flex",alignItems:"center",justifyContent:"center",
          fontSize:"1.1rem",boxShadow:`0 4px 12px ${IND}44`}}>🛣️</div>
        <div>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:"0.95rem",color:INK,letterSpacing:-0.3}}>
            Endringsmelding
          </div>
          <div style={{fontFamily:FB,fontSize:"0.62rem",color:MUTED,fontWeight:500}}>
            {modus==="v4"?"NVDB V4 · Objektdetaljer":modus==="v2"?"NVDB V2 · Kontraktsoppfølging":"NVDB · Kontraktsoppfølging"}
          </div>
        </div>
      </div>
      <div style={{marginLeft:"auto",display:"flex",gap:"0.5rem",alignItems:"center"}}>
        {modus&&(
          <button className="btn btn-ghost btn-sm" onClick={onModus}>
            ← Bytt modus
          </button>
        )}
        {modus==="v2"&&(
          <button className="btn btn-ghost btn-sm" onClick={onHjelp}
            style={{gap:"0.35rem"}}>
            💡 <span>Hjelp</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   NUDGE-BOBLE  (muntlig, oppmuntrende)
═══════════════════════════════════════════════════════════ */
function Nudge({emoji,tittel,tekst,variant="info",anim=false}) {
  const v = {
    info:    {bg:"#eef3ff", border:"#c7d7fe", col:BLU},
    suksess: {bg:GRNL,      border:"#86efac", col:GRN},
    advarsel:{bg:AMBL,      border:"#fde68a", col:AMB},
    hjelp:   {bg:"#faf5ff", border:"#d8b4fe", col:"#7c3aed"},
  }[variant];
  return (
    <div className={anim?"anim-in":""} style={{
      background:v.bg, border:`1.5px solid ${v.border}`,
      borderRadius:14, padding:"1rem 1.2rem", marginBottom:"1rem",
      display:"flex", gap:"0.8rem", alignItems:"flex-start"}}>
      <span style={{fontSize:"1.5rem",lineHeight:1.2,flexShrink:0}}>{emoji}</span>
      <div>
        {tittel&&<div style={{fontFamily:FB,fontWeight:700,fontSize:"0.84rem",
          color:v.col,marginBottom:"0.2rem"}}>{tittel}</div>}
        <div style={{fontFamily:FB,fontSize:"0.82rem",color:SUB,lineHeight:1.7}}>{tekst}</div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   DROPZONE
═══════════════════════════════════════════════════════════ */
function Dropzone({onFil,lastet,laster,feil}) {
  const ref = useRef(null);
  const [drag,setDrag] = useState(false);
  return (
    <div>
      <div
        onDragOver={e=>{e.preventDefault();setDrag(true);}}
        onDragLeave={()=>setDrag(false)}
        onDrop={e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files[0];if(f)onFil(f);}}
        onClick={()=>ref.current?.click()}
        style={{
          border:`2.5px dashed ${lastet?GRN:drag?IND:BORD}`,
          borderRadius:18, padding:"2.5rem 2rem",
          background: lastet?"#f0fdf8":drag?"#f0eeff":"#faf9ff",
          cursor:"pointer", textAlign:"center",
          transition:"all 0.2s",
          boxShadow:drag?`0 0 0 6px ${IND}18`:lastet?`0 0 0 4px ${GRN}18`:"none",
        }}>
        <input ref={ref} type="file" accept=".xlsx,.xls" style={{display:"none"}}
          onChange={e=>e.target.files[0]&&onFil(e.target.files[0])}/>

        {laster&&(
          <div>
            <div style={{fontSize:"3rem",marginBottom:"0.5rem",animation:"pulse 0.9s ease-in-out infinite"}}>⏳</div>
            <div style={{fontFamily:FB,fontWeight:700,fontSize:"1rem",color:IND}}>Leser filen…</div>
            <div style={{fontFamily:FB,fontSize:"0.78rem",color:MUTED,marginTop:"0.3rem"}}>Tar vanligvis noen sekunder</div>
          </div>
        )}
        {!laster&&!lastet&&(
          <div>
            <div style={{fontSize:"3.5rem",marginBottom:"0.6rem",
              animation:drag?"wiggle 0.4s ease-in-out infinite":"none"}}>{drag?"📂":"☁️"}</div>
            <div style={{fontFamily:FB,fontWeight:700,fontSize:"1.05rem",color:INK,marginBottom:"0.4rem"}}>
              {drag?"Slipp filen her! 🎯":"Dra Excel-filen hit"}
            </div>
            <div style={{fontFamily:FB,fontSize:"0.82rem",color:MUTED}}>
              eller{" "}
              <span style={{color:IND,fontWeight:700,borderBottom:`2px solid ${IND}55`,paddingBottom:"1px"}}>
                klikk for å velge
              </span>
            </div>
            <div style={{display:"inline-block",marginTop:"0.9rem",
              background:"#e8e4f8",borderRadius:8,padding:"4px 12px",
              fontFamily:FM,fontSize:"0.7rem",color:MUTED,letterSpacing:"0.05em"}}>
              .xlsx
            </div>
          </div>
        )}
        {!laster&&lastet&&(
          <div className="anim-in">
            <div className="stamp-in" style={{fontSize:"2.8rem",marginBottom:"0.4rem",display:"inline-block"}}>✅</div>
            <div style={{fontFamily:FB,fontWeight:700,fontSize:"0.95rem",color:GRN,marginBottom:"0.25rem"}}>
              {lastet.filnavn}
            </div>
            <div style={{fontFamily:FB,fontSize:"0.78rem",color:MUTED}}>
              {lastet.filKB} KB · <strong style={{color:SUB}}>{lastet.antall}</strong> objektkategorier funnet
            </div>
            <div style={{fontFamily:FB,fontSize:"0.7rem",color:MUTED,marginTop:"0.5rem",
              textDecoration:"underline",textDecorationStyle:"dotted"}}>Klikk for å bytte fil</div>
          </div>
        )}
      </div>
      {feil&&(
        <div className="anim-in" style={{marginTop:"0.7rem",background:REDL,
          border:`1.5px solid #fca5a5`,borderRadius:12,
          padding:"0.85rem 1rem",fontFamily:FB,fontSize:"0.8rem",color:RED,
          display:"flex",gap:"0.5rem",alignItems:"flex-start"}}>
          <span style={{fontSize:"1.1rem",flexShrink:0}}>⚠️</span>
          <span>{feil}</span>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   FIL-METADATA
═══════════════════════════════════════════════════════════ */
function FilMeta({meta,stempelet}) {
  if(!meta) return null;
  return (
    <div className="anim-in" style={{marginTop:"1rem",
      background:"#f7f5ff",border:`1.5px solid ${BORD}`,
      borderRadius:14,padding:"1rem 1.2rem",
      display:"flex",gap:"1.5rem",flexWrap:"wrap",alignItems:"center"}}>
      {meta.omrade&&(
        <div>
          <div style={{fontFamily:FB,fontSize:"0.66rem",fontWeight:600,color:MUTED,
            textTransform:"uppercase",letterSpacing:0.6,marginBottom:"0.2rem"}}>Område</div>
          <div style={{fontFamily:FB,fontWeight:700,color:INK,fontSize:"0.85rem"}}>{meta.omrade}</div>
        </div>
      )}
      {meta.gyldighetsdato&&(
        <div>
          <div style={{fontFamily:FB,fontSize:"0.66rem",fontWeight:600,color:MUTED,
            textTransform:"uppercase",letterSpacing:0.6,marginBottom:"0.2rem"}}>Gyldighetsdato</div>
          <div style={{fontFamily:FM,fontWeight:600,color:stempelet?GRN:AMB,fontSize:"0.88rem"}}>
            📅 {meta.gyldighetsdato}
          </div>
        </div>
      )}
      {meta.utskriftsdato&&(
        <div>
          <div style={{fontFamily:FB,fontSize:"0.66rem",fontWeight:600,color:MUTED,
            textTransform:"uppercase",letterSpacing:0.6,marginBottom:"0.2rem"}}>Utskriftsdato</div>
          <div style={{fontFamily:FM,fontWeight:500,color:SUB,fontSize:"0.82rem"}}>{meta.utskriftsdato}</div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   STEG 1 + 2  — FILOPPLASTING
═══════════════════════════════════════════════════════════ */
const STEG_COPY = [
  {
    tittel: "Last opp kontraktsgrunnlaget",
    ikon: "📋",
    undertittel: "Dette er referansepunktet — NVDB slik det så ut da kontrakten ble underskrevet.",
    nudge_intro: null,
    nudge_ok: {emoji:"🙌",tittel:"Bra jobbet!",tekst:"Grunnlagsfilen er klar. Nå trenger du bare å laste opp én fil til!"},
    dato_hint: <span>Sett gyldighetsdato til <strong style={{color:AMB}}>kontraktens startdato</strong></span>,
    neste: "Neste steg →",
  },
  {
    tittel: "Last opp nåværende rapport",
    ikon: "📊",
    undertittel: "Nå laster du opp dagens bilde av NVDB, slik at vi kan se hva som har endret seg.",
    nudge_intro: null,
    nudge_ok: {emoji:"🎯",tittel:"Perfekt! Begge filer er klare.",tekst:"Du er nå klar til å kjøre analysen. Bare ett klikk til!"},
    dato_hint: <span>Sett gyldighetsdato til <strong style={{color:GRN}}>dagens dato</strong></span>,
    neste: "Gå til bekreftelse →",
  },
];

function FilSteg({nr,forrigeInfo,onNeste,onTilbake}) {
  const [laster,setLaster]=useState(false);
  const [feil,setFeil]=useState(null);
  const [lastet,setLastet]=useState(null);
  const copy = STEG_COPY[nr-1];

  async function behandleFil(fil){
    setLaster(true);setFeil(null);setLastet(null);
    try{
      const p=await parseNVDBFil(fil);
      if(p.antall===0) throw new Error("Ingen datarader funnet i filen.");
      setLastet({...p,filnavn:fil.name,filKB:(fil.size/1024).toFixed(1)});
    }catch(e){setFeil(e.message);}
    finally{setLaster(false);}
  }

  return (
    <div className="anim-in" style={{maxWidth:660,margin:"0 auto"}}>
      {/* Header */}
      <div style={{textAlign:"center",marginBottom:"2rem"}}>
        <div className="pop-in" style={{fontSize:"3.8rem",display:"inline-block",marginBottom:"0.5rem"}}>
          {copy.ikon}
        </div>
        <h2 style={{fontFamily:FB,fontWeight:800,fontSize:"1.6rem",color:INK,
          marginBottom:"0.5rem",letterSpacing:-0.5}}>
          {copy.tittel}
        </h2>
        <p style={{fontFamily:FB,fontSize:"0.88rem",color:SUB,lineHeight:1.65,
          maxWidth:480,margin:"0 auto"}}>
          {copy.undertittel}
        </p>
      </div>

      {/* Kort */}
      <div className="card" style={{padding:"1.8rem 2rem"}}>
        {forrigeInfo&&(
          <Nudge emoji="✅" tittel="Grunnlagsfilen er lastet inn!"
            tekst={forrigeInfo} variant="suksess" anim/>
        )}

        {/* Steg-guide */}
        <div style={{marginBottom:"1.6rem"}}>
          <div style={{fontFamily:FB,fontWeight:700,fontSize:"0.7rem",color:MUTED,
            textTransform:"uppercase",letterSpacing:0.8,marginBottom:"0.9rem"}}>
            Slik gjør du det — 4 enkle steg
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:"0.55rem"}}>
            {[
              {t:<>Gå til <a href={NVDB_PORTAL} target="_blank" rel="noreferrer"
                style={{color:IND,fontWeight:700,textDecoration:"none",
                  borderBottom:`2px solid ${IND}44`}}>NVDB-portalen ↗</a></>},
              {t:"Velg kontraktsområde og rapporttype V2 (Aggregert mengdeoversikt)"},
              {t:copy.dato_hint},
              {t:"Last ned som Excel (.xlsx) og slipp filen i boksen under"},
            ].map((p,i)=>(
              <div key={i} className={`anim-in anim-in-d${i}`}
                style={{display:"flex",gap:"0.75rem",alignItems:"flex-start"}}>
                <div style={{width:26,height:26,borderRadius:"50%",flexShrink:0,
                  background:INDL,border:`2px solid ${IND}33`,
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontFamily:FM,fontWeight:600,fontSize:"0.72rem",color:IND}}>
                  {i+1}
                </div>
                <div style={{fontFamily:FB,fontSize:"0.84rem",color:SUB,lineHeight:1.65,paddingTop:"0.15rem"}}>
                  {p.t}
                </div>
              </div>
            ))}
          </div>
        </div>

        <Dropzone onFil={behandleFil} lastet={lastet} laster={laster} feil={feil}/>
        <FilMeta meta={lastet?.meta} stempelet={nr===2}/>

        {lastet&&(
          <div className="anim-in" style={{marginTop:"1rem"}}>
            <Nudge {...copy.nudge_ok} variant="suksess"/>
          </div>
        )}

        <div style={{marginTop:"1.4rem",display:"flex",
          justifyContent:onTilbake?"space-between":"flex-end",alignItems:"center"}}>
          {onTilbake&&(
            <button className="btn btn-ghost btn-md" onClick={onTilbake}>
              ← Tilbake
            </button>
          )}
          <button className={`btn btn-primary btn-lg${lastet?"":" "}`}
            disabled={!lastet}
            onClick={()=>lastet&&onNeste(lastet)}>
            {copy.neste}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   STEG 3  — BEKREFT
═══════════════════════════════════════════════════════════ */
function Steg3({grunnlag,navaerende,onResultat,onTilbake}) {
  const [kjorer,setKjorer]=useState(false);
  const advarsel=grunnlag.meta?.omrade&&navaerende.meta?.omrade&&
    grunnlag.meta.omrade!==navaerende.meta.omrade;

  function start(){
    setKjorer(true);
    setTimeout(()=>{ try{onResultat(kjorDiff(navaerende,grunnlag));}finally{setKjorer(false);} },80);
  }

  return (
    <div className="anim-in" style={{maxWidth:640,margin:"0 auto"}}>
      <div style={{textAlign:"center",marginBottom:"2rem"}}>
        <div className="pop-in" style={{fontSize:"3.8rem",display:"inline-block",marginBottom:"0.5rem"}}>🔍</div>
        <h2 style={{fontFamily:FB,fontWeight:800,fontSize:"1.6rem",color:INK,
          marginBottom:"0.5rem",letterSpacing:-0.5}}>
          Klar! La oss sjekke og starte.
        </h2>
        <p style={{fontFamily:FB,fontSize:"0.88rem",color:SUB,lineHeight:1.65}}>
          Se over at begge filer er riktige, og klikk start.
        </p>
      </div>

      <div className="card" style={{padding:"1.8rem 2rem"}}>
        {advarsel&&(
          <Nudge emoji="⚠️" tittel="Mulig feil — ulike kontraktsområder!"
            tekst="Filene ser ut til å ha ulike kontraktsområder. Sjekk at du har lastet opp riktige filer."
            variant="advarsel" anim/>
        )}

        {/* Fil-sammenlikning */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"1rem",marginBottom:"1.5rem"}}>
          {[
            {label:"📋 Grunnlag",data:grunnlag,col:AMB},
            {label:"📊 Nåværende",data:navaerende,col:GRN},
          ].map(({label,data,col})=>(
            <div key={label} style={{background:"#faf9ff",border:`1.5px solid ${BORD}`,
              borderRadius:14,padding:"1.1rem 1.2rem"}}>
              <div style={{fontFamily:FB,fontSize:"0.66rem",fontWeight:700,color:MUTED,
                textTransform:"uppercase",letterSpacing:0.6,marginBottom:"0.5rem"}}>{label}</div>
              <div style={{fontFamily:FB,fontWeight:700,color:INK,fontSize:"0.85rem",
                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
                marginBottom:"0.4rem"}} title={data.filnavn}>{data.filnavn}</div>
              {data.meta?.gyldighetsdato&&(
                <span className="tag" style={{background:`${col}18`,color:col,border:`1px solid ${col}44`,
                  fontSize:"0.74rem"}}>
                  📅 {data.meta.gyldighetsdato}
                </span>
              )}
              <div style={{fontFamily:FB,fontSize:"0.73rem",color:MUTED,marginTop:"0.4rem"}}>
                {data.antall} objektkategorier
              </div>
            </div>
          ))}
        </div>

        <Nudge emoji="💡" tittel="Hva skjer nå?"
          tekst="Appen sammenligner alle objektkategorier og beregner netto endring i mengde. Det tar bare noen sekunder — resultatene vises sortert etter størst endring øverst."
          variant="hjelp"/>

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <button className="btn btn-ghost btn-md" onClick={onTilbake}>← Tilbake</button>
          <button className={`btn btn-lg ${kjorer?"btn-ghost":"btn-primary"}`}
            onClick={start} disabled={kjorer}
            style={{minWidth:200,justifyContent:"center"}}>
            {kjorer
              ? <><span style={{animation:"pulse 0.8s ease-in-out infinite"}}>⏳</span> Analyserer…</>
              : <><span>🚀</span> Start analyse!</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   XP-BANNER
═══════════════════════════════════════════════════════════ */
function XPBanner({totalt}) {
  const xp = 50 + totalt*10;
  const [vis,setVis]=useState(false);
  useEffect(()=>{const t=setTimeout(()=>setVis(true),500);return()=>clearTimeout(t);},[]);
  if(!vis) return null;
  return (
    <div className="anim-in" style={{
      display:"inline-flex",alignItems:"center",gap:"0.6rem",
      background:`linear-gradient(135deg,${AMB},#f59e0b)`,
      borderRadius:30,padding:"7px 20px",
      boxShadow:`0 4px 18px ${AMB}55`,marginBottom:"0.5rem"}}>
      <span style={{fontSize:"1.2rem"}}>⚡</span>
      <span style={{fontFamily:FM,fontWeight:600,fontSize:"1rem",color:"#fff",letterSpacing:0.5}}>
        +{xp} XP
      </span>
      <span style={{fontFamily:FB,fontSize:"0.74rem",color:"rgba(255,255,255,0.85)"}}>
        Analyse fullført!
      </span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   STEG 4  — RESULTAT
═══════════════════════════════════════════════════════════ */
function Resultater({data,grunnlag,navaerende,onNy}) {
  const [filter,setFilter]=useState("alle");
  const [vegkatFilter,setVegkatFilter]=useState(new Set()); // tomt = alle
  const [apneRad,setApneRad]=useState(null);
  const [valgte,setValgte]=useState(new Set());
  const [konfetti,setKonfetti]=useState(true);
  const [minPst,setMinPst]=useState(false); // ≥5% filter
  const dato=new Date().toISOString().slice(0,10);

  useEffect(()=>{const t=setTimeout(()=>setKonfetti(false),3500);return()=>clearTimeout(t);},[]);

  const {oppsummering,endringsliste,vegkategorier}=data;

  // Aktive vegkategorier (tom = alle)
  const aktiveVK = vegkatFilter.size>0 ? [...vegkatFilter] : null;

  function toggleVegkat(vk){
    setVegkatFilter(prev=>{
      const n=new Set(prev);
      n.has(vk)?n.delete(vk):n.add(vk);
      return n;
    });
    setApneRad(null); // lukk åpne detaljer ved filterbytte
  }

  const filtrert=endringsliste.filter(e=>{
    if(filter!=="alle" && e.endringstype!==filter) return false;
    if(aktiveVK){
      // Behold rader som har endring i minst én av de valgte vegkategoriene
      const harEndring=aktiveVK.some(vk=>{
        const dv=e.diff?.[vk];
        return dv && Object.values(dv).some(v=>v!=null&&Math.abs(v)>0.001);
      });
      if(!harEndring) return false;
    }
    return true;
  });
  const totalt=oppsummering.totaltEndret+oppsummering.totaltTilgang+oppsummering.totaltAvgang;

  function toggleValgt(b){setValgte(p=>{const n=new Set(p);n.has(b)?n.delete(b):n.add(b);return n;});}
  function velgAlle(){
    const alleValgt=filtrertSortert.every(e=>valgte.has(e.beskrivelse));
    setValgte(alleValgt?new Set():new Set(filtrertSortert.map(e=>e.beskrivelse)));
  }
  function sendEpost(){
    const ut=endringsliste.filter(e=>valgte.has(e.beskrivelse));
    if(!ut.length) return;
    lastNed(lagCSV(ut,vegkategorier),`endringsmelding_${dato}.csv`,"text/csv;charset=utf-8");
    const lin=ut.map(e=>{
      const d=primærVerdi(e,"diff",aktiveVK);
      const ds=d?`${d.sum>0?"+":""}${d.sum.toLocaleString("nb-NO")} ${d.type==="lengde"?"m":d.type==="areal"?"m²":"stk"}`:"";
      return `  ${ET[e.endringstype].emoji} ${e.beskrivelse}  ${ds}`.trimEnd();
    });
    const body=[EPOST_TITTEL,"",
      `Kontraktsområde: ${grunnlag.meta?.omrade??""}`,
      `Grunnlag (dato): ${grunnlag.meta?.gyldighetsdato??"—"}`,
      `Nåværende (dato): ${navaerende.meta?.gyldighetsdato??dato}`,
      `Antall valgte endringer: ${ut.length}`,"","Oversikt:",...lin,"",
      `Vedlegg: endringsmelding_${dato}.csv`,
      "(CSV-filen ble lastet ned automatisk — legg den ved manuelt)",
    ].join("\n");
    window.location.href=`mailto:?subject=${encodeURIComponent(EPOST_TITTEL)}&body=${encodeURIComponent(body)}`;
  }

  const enhet=t=>t==="lengde"?"m":t==="areal"?"m²":"stk";

  // Beregn prosent-endring for en rad basert på aktive vegkategorier
  function beregnPst(e){
    const foer=primærVerdi(e,"foer",aktiveVK);
    const diff=primærVerdi(e,"diff",aktiveVK);
    if(!foer||!diff||foer.sum===0) return null;
    return Math.round((diff.sum/Math.abs(foer.sum))*1000)/10; // én desimal
  }

  // Sorter filtrert synkende på absolutt prosentendring
  const filtrertSortert=[...filtrert]
    .filter(e=>{
      if(!minPst) return true;
      // Ny/fjernet alltid med når minPst er på (ingen grunnlag å beregne %)
      if(e.endringstype!=="endret") return true;
      const pst=beregnPst(e);
      return pst===null || Math.abs(pst)>=5;
    })
    .sort((a,b)=>{
    const pa=beregnPst(a), pb=beregnPst(b);
    const absA=pa!=null?Math.abs(pa):Math.abs(primærVerdi(a,"diff",aktiveVK)?.sum??0);
    const absB=pb!=null?Math.abs(pb):Math.abs(primærVerdi(b,"diff",aktiveVK)?.sum??0);
    return absB-absA;
  });

  return (
    <div style={{maxWidth:1100,margin:"0 auto"}}>
      {konfetti&&<Konfetti/>}

      {/* Feiring-header */}
      <div className="anim-in" style={{textAlign:"center",marginBottom:"2rem"}}>
        <div className="stamp-in" style={{fontSize:"4rem",display:"inline-block",marginBottom:"0.5rem"}}>
          🎯
        </div>
        <h2 style={{fontFamily:FB,fontWeight:800,fontSize:"1.9rem",color:INK,
          letterSpacing:-0.5,marginBottom:"0.4rem"}}>
          Analysen er ferdig!
        </h2>
        <p style={{fontFamily:FB,color:SUB,fontSize:"0.9rem",marginBottom:"0.8rem",lineHeight:1.6}}>
          {totalt===0
            ?"Ingen endringer funnet siden kontraktsdato. Alt ser likt ut! 🎉"
            :`Fant ${totalt} endring${totalt!==1?"er":""} siden kontraktsdato.`}
        </p>
        {totalt>0&&<XPBanner totalt={totalt}/>}
      </div>

      {/* Score-kort  ×3 */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:"0.9rem",marginBottom:"1.1rem"}}>
        {[
          {key:"endret",  n:oppsummering.totaltEndret,  ...ET.endret  },
          {key:"tilgang", n:oppsummering.totaltTilgang, ...ET.tilgang },
          {key:"avgang",  n:oppsummering.totaltAvgang,  ...ET.avgang  },
        ].map((k,i)=>{
          const aktiv=filter===k.key;
          return (
            <div key={k.key} className={`card card-lift anim-in anim-in-d${i}`}
              onClick={()=>setFilter(aktiv?"alle":k.key)}
              style={{padding:"1.3rem",textAlign:"center",cursor:"pointer",
                background:aktiv?k.bg:WHITE,
                border:`2px solid ${aktiv?k.color:BORD}`,
                boxShadow:aktiv?`0 6px 22px ${k.color}30`:"0 2px 10px rgba(91,69,214,0.05)"}}>
              <div style={{fontSize:"2rem",marginBottom:"0.3rem"}}>{k.emoji}</div>
              <div style={{fontFamily:FM,fontSize:"2.5rem",fontWeight:600,
                color:k.color,lineHeight:1}}>{k.n}</div>
              <div style={{fontFamily:FB,fontSize:"0.73rem",fontWeight:700,color:SUB,
                marginTop:"0.3rem",textTransform:"uppercase",letterSpacing:0.5}}>{k.label}</div>
              {aktiv&&<div style={{fontFamily:FB,fontSize:"0.66rem",color:k.color,
                marginTop:"0.3rem",fontWeight:600}}>↑ filtrert</div>}
            </div>
          );
        })}
      </div>

      {/* Eksport + e-post panel */}
      <div className="card anim-in" style={{padding:"1.1rem 1.4rem",marginBottom:"0.9rem",
        display:"flex",alignItems:"center",justifyContent:"space-between",
        flexWrap:"wrap",gap:"0.8rem"}}>
        <div>
          <div style={{fontFamily:FB,fontWeight:700,color:INK,fontSize:"0.9rem"}}>
            {valgte.size>0
              ?`${valgte.size} rad${valgte.size!==1?"er":""} valgt for e-post`
              :"Eksport og deling"}
          </div>
          <div style={{fontFamily:FB,fontSize:"0.77rem",color:MUTED,marginTop:"0.15rem"}}>
            {valgte.size>0
              ?"Klar! CSV lastes ned og e-postklienten åpnes automatisk."
              :"Kryss av i tabellen og send til byggemøtet, eller last ned alt."}
          </div>
        </div>
        <div style={{display:"flex",gap:"0.5rem",flexWrap:"wrap"}}>
          <button className="btn btn-ghost btn-sm"
            onClick={()=>lastNed(lagCSV(endringsliste,vegkategorier),`endringsmelding_${dato}.csv`,"text/csv;charset=utf-8")}>
            ⬇ Last ned CSV
          </button>
          {valgte.size>0&&<>
            <button className="btn btn-ghost btn-sm" onClick={()=>setValgte(new Set())}>
              ✕ Nullstill
            </button>
            <button className="btn btn-green btn-sm" onClick={sendEpost}>
              ✉ Send e-post ({valgte.size})
            </button>
          </>}
          <button className="btn btn-ghost btn-sm" onClick={onNy}>↺ Ny analyse</button>
        </div>
      </div>

      {/* Tabell */}
      {endringsliste.length>0&&(
        <div className="card anim-in" style={{padding:"1.4rem 1.6rem"}}>
          {/* Filter-piller */}
          <div style={{display:"flex",gap:"0.4rem",marginBottom:"1rem",
            flexWrap:"wrap",alignItems:"center",justifyContent:"space-between"}}>
            <div style={{display:"flex",gap:"0.4rem",flexWrap:"wrap",alignItems:"center"}}>
              {[
                {k:"alle",    l:`Alle (${endringsliste.length})`},
                {k:"endret",  l:`🔄 Endret (${oppsummering.totaltEndret})`},
                {k:"tilgang", l:`✅ Nye (${oppsummering.totaltTilgang})`},
                {k:"avgang",  l:`🗑 Fjernet (${oppsummering.totaltAvgang})`},
              ].map(({k,l})=>(
                <button key={k} className="btn btn-sm"
                  onClick={()=>setFilter(k)}
                  style={{
                    background:filter===k?IND:"#f4f2ff",
                    color:filter===k?"#fff":SUB,
                    border:`1.5px solid ${filter===k?IND:BORD}`,
                    borderRadius:30,fontWeight:filter===k?700:500,
                    transition:"all 0.15s",
                  }}>
                  {l}
                </button>
              ))}

              {/* ≥5% toggle */}
              <div style={{marginLeft:"0.3rem",paddingLeft:"0.7rem",borderLeft:`1.5px solid ${BORD}`}}>
                <button
                  onClick={()=>setMinPst(p=>!p)}
                  style={{
                    display:"flex",alignItems:"center",gap:"0.45rem",
                    background:minPst?AMB:"#f4f2ff",
                    color:minPst?"#fff":SUB,
                    border:`1.5px solid ${minPst?AMB:BORD}`,
                    borderRadius:30,padding:"5px 13px",
                    fontFamily:FB,fontSize:"0.75rem",fontWeight:minPst?700:500,
                    cursor:"pointer",transition:"all 0.15s",
                    boxShadow:minPst?`0 2px 8px ${AMB}44`:"none",
                  }}>
                  <span style={{fontSize:"0.85rem"}}>📊</span>
                  {minPst?"✓ ≥5% endring":"≥5% endring"}
                </button>
              </div>
            </div>
            <div style={{fontFamily:FB,fontSize:"0.72rem",color:MUTED}}>
              💡 Klikk en rad for detaljer
            </div>
          </div>

          {/* Vegkategori flervalg */}
          <div style={{marginBottom:"1rem",padding:"0.85rem 1rem",
            background:"#faf9ff",border:`1.5px solid ${BORD}`,borderRadius:14,
            display:"flex",gap:"0.6rem",alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontFamily:FB,fontSize:"0.72rem",fontWeight:700,
              color:MUTED,whiteSpace:"nowrap"}}>🛣 Vegkategori:</span>
            {vegkategorier.map(vk=>{
              const aktiv=vegkatFilter.has(vk);
              return(
                <button key={vk} className="btn btn-sm"
                  onClick={()=>toggleVegkat(vk)}
                  style={{
                    background:aktiv?IND:WHITE,
                    color:aktiv?"#fff":SUB,
                    border:`1.5px solid ${aktiv?IND:BORD}`,
                    borderRadius:20,fontWeight:aktiv?700:500,
                    padding:"5px 13px",transition:"all 0.15s",
                    boxShadow:aktiv?`0 2px 8px ${IND}33`:"none",
                  }}>
                  {aktiv?"✓ ":""}{vk}
                </button>
              );
            })}
            {vegkatFilter.size>0&&(
              <button onClick={()=>setVegkatFilter(new Set())}
                style={{background:"none",border:`1px solid ${BORD}`,borderRadius:20,
                  padding:"5px 11px",fontFamily:FB,fontSize:"0.72rem",
                  color:MUTED,cursor:"pointer",transition:"all 0.15s"}}>
                ✕ Nullstill
              </button>
            )}
            {vegkatFilter.size>0&&(
              <span style={{fontFamily:FB,fontSize:"0.72rem",color:IND,fontWeight:600,marginLeft:"0.2rem"}}>
                — tall og summer viser kun valgte kategorier
              </span>
            )}
          </div>

          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"separate",borderSpacing:"0 3px"}}>
              <thead>
                <tr>
                  <th style={{width:40,padding:"4px 10px",borderBottom:`2px solid ${BORD}`}}>
                    <input type="checkbox"
                      checked={filtrertSortert.length>0&&filtrertSortert.every(e=>valgte.has(e.beskrivelse))}
                      onChange={velgAlle}
                      style={{cursor:"pointer",accentColor:IND,width:16,height:16}}/>
                  </th>
                  {["Type","Beskrivelse","ID","Grunnlag","Nå","Differanse","Endring %","Kart"].map(h=>(
                    <th key={h} style={{
                      padding:"6px 12px",fontFamily:FB,fontSize:"0.68rem",fontWeight:700,
                      color:MUTED,textTransform:"uppercase",letterSpacing:0.4,
                      borderBottom:`2px solid ${BORD}`,
                      textAlign:["Grunnlag","Nå","Differanse","Endring %"].includes(h)?"right":"left",
                      whiteSpace:"nowrap",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtrertSortert.map((e,i)=>{
                  const et=ET[e.endringstype];
                  const foer=primærVerdi(e,"foer",aktiveVK);
                  const naa=primærVerdi(e,"naa",aktiveVK);
                  const diff=primærVerdi(e,"diff",aktiveVK);
                  const pst=beregnPst(e);
                  const apne=apneRad===e.beskrivelse;
                  const valgt=valgte.has(e.beskrivelse);
                  const rBg=valgt?"#f0fff8":apne?"#faf9ff":i%2===0?WHITE:"#fbfaff";

                  return [
                    <tr key={e.beskrivelse} className="row-hover"
                      onClick={()=>setApneRad(apne?null:e.beskrivelse)}
                      style={{background:rBg,
                        outline:apne?`2px solid ${IND}44`:valgt?`1.5px solid ${GRN}55`:"none",
                        borderRadius:8}}>
                      <td style={{padding:"10px 10px",borderLeft:`4px solid ${et.color}`,borderRadius:"8px 0 0 8px"}}
                        onClick={ev=>ev.stopPropagation()}>
                        <input type="checkbox" checked={valgt}
                          onChange={ev=>{ev.stopPropagation();toggleValgt(e.beskrivelse);}}
                          style={{cursor:"pointer",accentColor:GRN,width:16,height:16}}/>
                      </td>
                      <td style={{padding:"10px 12px"}}>
                        <span className="tag" style={{background:et.bg,color:et.color,border:`1px solid ${et.border}`}}>
                          {et.emoji} {et.label}
                        </span>
                      </td>
                      <td style={{padding:"10px 12px",fontFamily:FB,fontWeight:600,color:INK,
                        maxWidth:230,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                        title={e.beskrivelse}>{e.beskrivelse}</td>
                      <td style={{padding:"10px 12px",fontFamily:FM,fontSize:"0.72rem",color:MUTED}}>
                        {e.typeId}
                      </td>
                      <td style={{padding:"10px 12px",textAlign:"right",fontFamily:FM,fontSize:"0.78rem",color:RED}}>
                        {foer?`${foer.sum.toLocaleString("nb-NO")} ${enhet(foer.type)}`:"—"}
                      </td>
                      <td style={{padding:"10px 12px",textAlign:"right",fontFamily:FM,fontSize:"0.78rem",color:GRN}}>
                        {naa?`${naa.sum.toLocaleString("nb-NO")} ${enhet(naa.type)}`:"—"}
                      </td>
                      <td style={{padding:"10px 12px",textAlign:"right",fontFamily:FM,
                        fontSize:"0.84rem",fontWeight:600}}>
                        {diff?(
                          <span style={{color:diff.sum>0?GRN:diff.sum<0?RED:MUTED}}>
                            {diff.sum>0?"+":""}{diff.sum.toLocaleString("nb-NO")}
                            {" "}<span style={{fontFamily:FM,fontWeight:400,fontSize:"0.68rem",color:MUTED}}>
                              {enhet(diff.type)}
                            </span>
                          </span>
                        ):"—"}
                      </td>
                      <td style={{padding:"10px 12px",textAlign:"right"}}>
                        {pst!=null?(
                          <span style={{
                            display:"inline-block",
                            background:pst>0?`${GRN}18`:pst<0?`${RED}18`:"#f4f2ff",
                            color:pst>0?GRN:pst<0?RED:MUTED,
                            border:`1.5px solid ${pst>0?`${GRN}44`:pst<0?`${RED}44`:BORD}`,
                            borderRadius:20,padding:"3px 10px",
                            fontFamily:FM,fontSize:"0.78rem",fontWeight:700,
                            whiteSpace:"nowrap",
                          }}>
                            {pst>0?"+":""}{pst.toLocaleString("nb-NO")} %
                          </span>
                        ):(
                          <span style={{fontFamily:FM,fontSize:"0.72rem",color:MUTED}}>ny/fjernet</span>
                        )}
                      </td>
                      <td style={{padding:"10px 12px",borderRadius:"0 8px 8px 0",textAlign:"center"}}>
                        {e.typeId&&(
                          <a href={`${VEGKART_TYPE}${e.typeId}`} target="_blank" rel="noreferrer"
                            onClick={ev=>ev.stopPropagation()}
                            style={{fontFamily:FB,fontSize:"0.72rem",color:BLU,
                              textDecoration:"none",background:BLUL,
                              border:`1px solid #bfdbfe`,borderRadius:20,
                              padding:"4px 10px",whiteSpace:"nowrap",display:"inline-block"}}>
                            🗺 Kart
                          </a>
                        )}
                      </td>
                    </tr>,

                    /* ── Detaljrad ── */
                    apne?(
                      <tr key={e.beskrivelse+"-exp"}>
                        <td colSpan={9} style={{padding:"0 10px 10px 10px"}}>
                          <div className="anim-in" style={{background:"#faf9ff",
                            border:`1.5px solid ${BORD}`,borderRadius:14,
                            padding:"1.1rem 1.3rem"}}>
                            <div style={{fontFamily:FB,fontWeight:700,fontSize:"0.78rem",
                              color:SUB,marginBottom:"0.7rem"}}>
                              📊 Fordeling per vegkategori
                              <span style={{fontWeight:400,color:MUTED}}> — {e.typenavn||e.beskrivelse}</span>
                            </div>
                            <div style={{overflowX:"auto"}}>
                              <table style={{borderCollapse:"collapse",fontSize:"0.74rem",width:"100%"}}>
                                <thead>
                                  <tr style={{borderBottom:`2px solid ${BORD}`}}>
                                    <th style={{padding:"5px 12px",fontFamily:FB,color:MUTED,
                                      textAlign:"left",fontWeight:700,whiteSpace:"nowrap"}}>Vegkategori</th>
                                    {["antall","lengde","areal"].map(t=>[
                                      <th key={t+"-f"} style={{padding:"5px 10px",color:RED,textAlign:"right",fontFamily:FB,fontWeight:600,whiteSpace:"nowrap"}}>{t} (grunnlag)</th>,
                                      <th key={t+"-n"} style={{padding:"5px 10px",color:GRN,textAlign:"right",fontFamily:FB,fontWeight:600,whiteSpace:"nowrap"}}>{t} (nå)</th>,
                                      <th key={t+"-d"} style={{padding:"5px 10px",color:AMB,textAlign:"right",fontFamily:FM,fontWeight:700,whiteSpace:"nowrap"}}>Δ {t}</th>,
                                    ])}
                                  </tr>
                                </thead>
                                <tbody>
                                  {(aktiveVK || e.vegkategorier||[]).map((vk,vi)=>{
                                    const fV=e.verdierFoer?.[vk]??{},nV=e.verdierNaa?.[vk]??{},dV=e.diff?.[vk]??{};
                                    const harNoe=["antall","lengde","areal"].some(t=>fV[t]!=null||nV[t]!=null||dV[t]);
                                    if(!harNoe) return null;
                                    return(
                                      <tr key={vk} style={{background:vi%2===0?WHITE:"#faf9ff",
                                        borderBottom:`1px solid ${BORD}`}}>
                                        <td style={{padding:"6px 12px",fontFamily:FB,fontWeight:700,color:INK}}>
                                          {vk}
                                        </td>
                                        {["antall","lengde","areal"].map(t=>{
                                          const d=dV[t]??0;
                                          return[
                                            <td key={t+"-f"} style={{padding:"6px 10px",textAlign:"right",fontFamily:FM,color:RED}}>
                                              {fV[t]!=null?fV[t].toLocaleString("nb-NO"):"—"}
                                            </td>,
                                            <td key={t+"-n"} style={{padding:"6px 10px",textAlign:"right",fontFamily:FM,color:GRN}}>
                                              {nV[t]!=null?nV[t].toLocaleString("nb-NO"):"—"}
                                            </td>,
                                            <td key={t+"-d"} style={{padding:"6px 10px",textAlign:"right",fontFamily:FM,fontWeight:700,
                                              color:Math.abs(d)<0.001?MUTED:d>0?GRN:RED}}>
                                              {Math.abs(d)<0.001?"—":`${d>0?"+":""}${d.toLocaleString("nb-NO")}`}
                                            </td>,
                                          ];
                                        })}
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ):null,
                  ];
                })}
              </tbody>
            </table>
          </div>

          {filtrertSortert.length===0&&(
            <div style={{textAlign:"center",padding:"3rem",color:MUTED,fontFamily:FB}}>
              <div style={{fontSize:"2.8rem",marginBottom:"0.5rem"}}>🔍</div>
              Ingen endringer i denne kategorien
            </div>
          )}
        </div>
      )}

      {endringsliste.length===0&&(
        <div className="card anim-in" style={{padding:"3.5rem",textAlign:"center"}}>
          <div className="stamp-in" style={{fontSize:"3.5rem",display:"inline-block",marginBottom:"0.8rem"}}>🎉</div>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:"1.3rem",color:GRN,marginBottom:"0.4rem"}}>
            Ingen endringer!
          </div>
          <div style={{fontFamily:FB,color:SUB,lineHeight:1.6}}>
            Alle objektkategorier er identiske mellom de to rapportene.
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   HJELPEMODAL
═══════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════
   V4 — DROPZONE (gjenbruker Dropzone, men med V4-parser)
═══════════════════════════════════════════════════════════ */
function V4FilSteg({nr, onNeste, onTilbake, forrigeInfo}) {
  const [lastet, setLastet] = useState(null);
  const [feil, setFeil]     = useState(null);
  const [laster, setLaster] = useState(false);

  async function behandleFil(fil) {
    setFeil(null); setLaster(true);
    try {
      const buf = await fil.arrayBuffer();
      const data = parseV4Xlsx(new Uint8Array(buf));
      if (!data.objekttyper.length) throw new Error("Fant ingen V4-objektark i filen. Er dette en V4-rapport?");
      data.filnavn = fil.name;
      data.filKB   = Math.round(fil.size/1024);
      setLastet(data);
    } catch(e) {
      setFeil(e.message||"Kunne ikke lese filen.");
    } finally { setLaster(false); }
  }

  return (
    <div className="anim-in" style={{maxWidth:640,margin:"0 auto"}}>
      <div style={{textAlign:"center",marginBottom:"1.8rem"}}>
        <div className="pop-in" style={{fontSize:"3.2rem",display:"inline-block",marginBottom:"0.4rem"}}>
          {nr===1?"📋":"📊"}
        </div>
        <h2 style={{fontFamily:FB,fontWeight:800,fontSize:"1.5rem",color:INK,marginBottom:"0.3rem"}}>
          {nr===1?"V4 Grunnlag":"V4 Nåværende"}
        </h2>
        <p style={{fontFamily:FB,fontSize:"0.84rem",color:SUB,lineHeight:1.6}}>
          {nr===1
            ?"Last opp V4-rapporten fra kontraktsdato (grunnlaget)"
            :"Last opp V4-rapporten med dagens dato"}
        </p>
        {forrigeInfo&&(
          <div style={{marginTop:"0.6rem",fontFamily:FB,fontSize:"0.76rem",
            color:IND,background:INDL,border:`1px solid #c4b8f8`,
            borderRadius:20,padding:"4px 14px",display:"inline-block"}}>
            ✓ Grunnlag: {forrigeInfo}
          </div>
        )}
      </div>
      <div className="card" style={{padding:"1.8rem"}}>
        <Dropzone onFil={behandleFil} laster={laster} lastet={lastet}
          hint="V4 Detaljert mengdeoversikt (.xlsx)"/>
        {lastet&&<FilMeta meta={lastet.meta} stempelet={nr===2}/>}
        {lastet&&(
          <div style={{marginTop:"0.8rem",fontFamily:FB,fontSize:"0.76rem",color:MUTED}}>
            📂 {lastet.objekttyper.length} objekttyper · {lastet.antall.toLocaleString("nb-NO")} objekter totalt
          </div>
        )}
        {feil&&(
          <div className="anim-in" style={{marginTop:"0.7rem",background:REDL,
            border:`1.5px solid #fca5a5`,borderRadius:12,
            padding:"0.85rem 1rem",fontFamily:FB,fontSize:"0.8rem",color:RED}}>
            ⚠️ {feil}
          </div>
        )}
        <div style={{display:"flex",justifyContent:"space-between",marginTop:"1.4rem"}}>
          <button className="btn btn-ghost btn-md" onClick={onTilbake}>← Tilbake</button>
          <button className={`btn btn-lg ${lastet?"btn-primary":"btn-ghost"}`}
            disabled={!lastet} onClick={()=>lastet&&onNeste(lastet)}>
            {nr===1?"Neste: last opp nåværende →":"Kjør V4-analyse 🚀"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   V4 — RESULTATER
═══════════════════════════════════════════════════════════ */
function V4Resultater({data, grunnlag, navaerende, onNy}) {
  const {endringer, oppsummering} = data;
  const [typeFilter,  setTypeFilter]  = useState("alle");
  const [etFilter,    setEtFilter]    = useState("alle");
  const [vkFilter,    setVkFilter]    = useState(new Set());
  const [konfetti,    setKonfetti]    = useState(true);

  useEffect(()=>{const t=setTimeout(()=>setKonfetti(false),3500);return()=>clearTimeout(t);},[]);

  // Unike verdier for filter
  const alleTyper = [...new Set(endringer.map(e=>e.visning))].sort();
  const alleVK    = [...new Set(endringer.map(e=>e.vegkat))].sort();

  const aktiveVK  = vkFilter.size>0 ? [...vkFilter] : null;

  const filtrert  = endringer.filter(e=>{
    if (typeFilter!=="alle" && e.visning!==typeFilter) return false;
    if (etFilter!=="alle"   && e.endringstype!==etFilter) return false;
    if (aktiveVK && !aktiveVK.includes(e.vegkat)) return false;
    return true;
  });

  // Sorter synkende på absolutt prosent endring
  const sortert = [...filtrert].sort((a,b)=>{
    const pstA = a.mengdeFoer ? Math.abs((a.diff??0)/Math.abs(a.mengdeFoer)*100) : Infinity;
    const pstB = b.mengdeFoer ? Math.abs((b.diff??0)/Math.abs(b.mengdeFoer)*100) : Infinity;
    if (pstB !== pstA) return pstB - pstA;
    return Math.abs(b.diff??0) - Math.abs(a.diff??0);
  });

  const totalt = oppsummering.totaltTilgang + oppsummering.totaltAvgang + oppsummering.totaltEndret;
  const enhet  = t=>t==="areal"?"m²":t==="antall"?"stk":"m";

  return (
    <div style={{maxWidth:1200,margin:"0 auto"}}>
      {konfetti&&<Konfetti/>}

      {/* Header */}
      <div className="anim-in" style={{textAlign:"center",marginBottom:"1.8rem"}}>
        <div className="stamp-in" style={{fontSize:"3.5rem",display:"inline-block",marginBottom:"0.4rem"}}>🗺️</div>
        <h2 style={{fontFamily:FB,fontWeight:800,fontSize:"1.8rem",color:INK,
          letterSpacing:-0.5,marginBottom:"0.4rem"}}>
          V4-analyse ferdig!
        </h2>
        <p style={{fontFamily:FB,color:SUB,fontSize:"0.88rem",lineHeight:1.6}}>
          {totalt===0
            ?"Ingen endringer funnet mellom de to V4-rapportene 🎉"
            :`Fant ${totalt} endrede objekter på tvers av ${alleTyper.length} objekttyper`}
        </p>
      </div>

      {/* Score-kort */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:"0.9rem",marginBottom:"1.1rem"}}>
        {[
          {key:"endret",  n:oppsummering.totaltEndret,  ...ET.endret},
          {key:"tilgang", n:oppsummering.totaltTilgang, ...ET.tilgang},
          {key:"avgang",  n:oppsummering.totaltAvgang,  ...ET.avgang},
        ].map((k,i)=>{
          const aktiv=etFilter===k.key;
          return(
            <div key={k.key} className={`card card-lift anim-in anim-in-d${i}`}
              onClick={()=>setEtFilter(aktiv?"alle":k.key)}
              style={{padding:"1.2rem",textAlign:"center",cursor:"pointer",
                background:aktiv?k.bg:WHITE,
                border:`2px solid ${aktiv?k.color:BORD}`,
                boxShadow:aktiv?`0 6px 22px ${k.color}30`:""}}>
              <div style={{fontSize:"1.8rem",marginBottom:"0.2rem"}}>{k.emoji}</div>
              <div style={{fontFamily:FM,fontSize:"2.2rem",fontWeight:600,color:k.color,lineHeight:1}}>{k.n}</div>
              <div style={{fontFamily:FB,fontSize:"0.7rem",fontWeight:700,color:SUB,
                marginTop:"0.2rem",textTransform:"uppercase",letterSpacing:0.5}}>{k.label}</div>
              {aktiv&&<div style={{fontFamily:FB,fontSize:"0.65rem",color:k.color,marginTop:"0.2rem",fontWeight:600}}>↑ filtrert</div>}
            </div>
          );
        })}
      </div>

      {/* Tabell */}
      <div className="card anim-in" style={{padding:"1.4rem 1.6rem"}}>

        {/* Filter — objekttype */}
        <div style={{marginBottom:"0.8rem"}}>
          <div style={{fontFamily:FB,fontSize:"0.72rem",fontWeight:700,color:MUTED,
            textTransform:"uppercase",letterSpacing:0.5,marginBottom:"0.5rem"}}>
            📂 Objekttype
          </div>
          <div style={{display:"flex",gap:"0.35rem",flexWrap:"wrap"}}>
            <button className="btn btn-sm"
              onClick={()=>setTypeFilter("alle")}
              style={{background:typeFilter==="alle"?IND:"#f4f2ff",
                color:typeFilter==="alle"?"#fff":SUB,
                border:`1.5px solid ${typeFilter==="alle"?IND:BORD}`,
                borderRadius:30,fontWeight:typeFilter==="alle"?700:500}}>
              Alle ({endringer.length})
            </button>
            {alleTyper.map(t=>{
              const antall=endringer.filter(e=>e.visning===t).length;
              const aktiv=typeFilter===t;
              return(
                <button key={t} className="btn btn-sm"
                  onClick={()=>setTypeFilter(aktiv?"alle":t)}
                  style={{background:aktiv?IND:"#f4f2ff",color:aktiv?"#fff":SUB,
                    border:`1.5px solid ${aktiv?IND:BORD}`,
                    borderRadius:30,fontWeight:aktiv?700:500}}>
                  {aktiv?"✓ ":""}{t} ({antall})
                </button>
              );
            })}
          </div>
        </div>

        {/* Filter — vegkategori */}
        {alleVK.length>1&&(
          <div style={{marginBottom:"0.8rem",padding:"0.75rem 1rem",
            background:"#faf9ff",border:`1.5px solid ${BORD}`,borderRadius:12,
            display:"flex",gap:"0.5rem",alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontFamily:FB,fontSize:"0.72rem",fontWeight:700,color:MUTED}}>🛣 Vegkategori:</span>
            {alleVK.map(vk=>{
              const aktiv=vkFilter.has(vk);
              return(
                <button key={vk} className="btn btn-sm"
                  onClick={()=>setVkFilter(prev=>{const n=new Set(prev);aktiv?n.delete(vk):n.add(vk);return n;})}
                  style={{background:aktiv?IND:WHITE,color:aktiv?"#fff":SUB,
                    border:`1.5px solid ${aktiv?IND:BORD}`,
                    borderRadius:20,fontWeight:aktiv?700:500,
                    boxShadow:aktiv?`0 2px 8px ${IND}33`:"none"}}>
                  {aktiv?"✓ ":""}{vk}
                </button>
              );
            })}
            {vkFilter.size>0&&(
              <button onClick={()=>setVkFilter(new Set())}
                style={{background:"none",border:`1px solid ${BORD}`,borderRadius:20,
                  padding:"5px 11px",fontFamily:FB,fontSize:"0.72rem",color:MUTED,cursor:"pointer"}}>
                ✕ Nullstill
              </button>
            )}
          </div>
        )}

        {/* Info-rad */}
        <div style={{display:"flex",justifyContent:"space-between",
          alignItems:"center",marginBottom:"0.8rem"}}>
          <div style={{fontFamily:FB,fontSize:"0.78rem",color:SUB,fontWeight:600}}>
            Viser {sortert.length} av {endringer.length} endringer
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onNy}>↺ Ny analyse</button>
        </div>

        {/* Tabell */}
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"separate",borderSpacing:"0 3px"}}>
            <thead>
              <tr>
                {["Type","Objekt ID","Vegkat","Grunnlag","Nå","Diff","Endring %","Vegkart"].map(h=>(
                  <th key={h} style={{padding:"6px 12px",fontFamily:FB,fontSize:"0.68rem",fontWeight:700,
                    color:MUTED,textTransform:"uppercase",letterSpacing:0.4,
                    borderBottom:`2px solid ${BORD}`,
                    textAlign:["Grunnlag","Nå","Diff","Endring %"].includes(h)?"right":"left",
                    whiteSpace:"nowrap"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortert.map((e,i)=>{
                const et=ET[e.endringstype];
                const pst = e.mengdeFoer && Math.abs(e.mengdeFoer)>0.001
                  ? Math.round((e.diff/Math.abs(e.mengdeFoer))*1000)/10
                  : null;
                const rBg=i%2===0?WHITE:"#fbfaff";
                const eu=enhet(e.mengdeType);
                return(
                  <tr key={`${e.arknavn}-${e.objId}`} style={{background:rBg}}>
                    <td style={{padding:"9px 12px",borderLeft:`4px solid ${et.color}`,borderRadius:"8px 0 0 8px"}}>
                      <span className="tag" style={{background:et.bg,color:et.color,
                        border:`1px solid ${et.border}`,fontSize:"0.7rem"}}>
                        {et.emoji} {et.label}
                      </span>
                    </td>
                    <td style={{padding:"9px 12px",fontFamily:FM,fontSize:"0.78rem",color:INK,fontWeight:600}}>
                      {e.objId}
                    </td>
                    <td style={{padding:"9px 12px"}}>
                      <span style={{fontFamily:FB,fontSize:"0.72rem",fontWeight:700,
                        background:INDL,color:IND,border:`1px solid #c4b8f8`,
                        borderRadius:20,padding:"2px 9px"}}>
                        {e.vegkat}
                      </span>
                    </td>
                    <td style={{padding:"9px 12px",textAlign:"right",fontFamily:FM,fontSize:"0.78rem",color:RED}}>
                      {e.mengdeFoer!=null?`${e.mengdeFoer.toLocaleString("nb-NO")} ${eu}`:"—"}
                    </td>
                    <td style={{padding:"9px 12px",textAlign:"right",fontFamily:FM,fontSize:"0.78rem",color:GRN}}>
                      {e.mengdeNaa!=null?`${e.mengdeNaa.toLocaleString("nb-NO")} ${eu}`:"—"}
                    </td>
                    <td style={{padding:"9px 12px",textAlign:"right",fontFamily:FM,fontSize:"0.82rem",fontWeight:600}}>
                      {e.diff!=null?(
                        <span style={{color:e.diff>0?GRN:e.diff<0?RED:MUTED}}>
                          {e.diff>0?"+":""}{e.diff.toLocaleString("nb-NO")} {eu}
                        </span>
                      ):"—"}
                    </td>
                    <td style={{padding:"9px 12px",textAlign:"right"}}>
                      {pst!=null?(
                        <span style={{display:"inline-block",
                          background:pst>0?`${GRN}18`:pst<0?`${RED}18`:"#f4f2ff",
                          color:pst>0?GRN:pst<0?RED:MUTED,
                          border:`1.5px solid ${pst>0?`${GRN}44`:pst<0?`${RED}44`:BORD}`,
                          borderRadius:20,padding:"3px 10px",
                          fontFamily:FM,fontSize:"0.78rem",fontWeight:700}}>
                          {pst>0?"+":""}{pst.toLocaleString("nb-NO")} %
                        </span>
                      ):(
                        <span style={{fontFamily:FM,fontSize:"0.72rem",color:MUTED}}>ny/fjernet</span>
                      )}
                    </td>
                    <td style={{padding:"9px 12px",borderRadius:"0 8px 8px 0",textAlign:"center"}}>
                      <a href={VEGKART_OBJ(e.objId, e.objekttypeId)} target="_blank" rel="noreferrer"
                        onClick={ev=>ev.stopPropagation()}
                        style={{fontFamily:FB,fontSize:"0.72rem",color:BLU,
                          textDecoration:"none",background:BLUL,
                          border:`1px solid #bfdbfe`,borderRadius:20,
                          padding:"4px 10px",whiteSpace:"nowrap",display:"inline-block"}}>
                        🗺 Kart
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sortert.length===0&&(
            <div style={{textAlign:"center",padding:"2.5rem",fontFamily:FB,color:MUTED}}>
              Ingen endringer matcher valgte filtre
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


const GUIDE = [
  {nr:"01",tittel:"Last ned grunnlagsfil",ikon:"📥",col:AMB,steg:[
    {t:"Gå til NVDB-portalen",d:"Åpne nvdb-vegnett-og-objektdata.atlas.vegvesen.no i nettleseren."},
    {t:"Velg kontraktsområde + V2",d:'Velg ditt kontraktsområde og rapporttype "V2 – Aggregert mengdeoversikt".'},
    {t:"Sett gyldighetsdato = kontraktsdato",d:"VIKTIG: Bruk datoen da kontrakten ble inngått. Dette er referansen alt sammenlignes mot."},
    {t:"Last ned som Excel",d:"Klikk Last ned, velg XLSX-format, og dra filen inn i Steg 1 i appen."},
  ]},
  {nr:"02",tittel:"Last ned nåværende rapport",ikon:"📊",col:GRN,steg:[
    {t:"Gå til NVDB-portalen igjen",d:"Samme nettadresse, samme kontraktsområde."},
    {t:"Velg SAMME kontraktsområde + V2",d:"Det er svært viktig å velge nøyaktig samme kontrakt som i grunnlagsfilen."},
    {t:"Sett gyldighetsdato = dagens dato",d:"Bruk dagens dato. Dette er «nå»-bildet som sammenlignes mot grunnlaget."},
    {t:"Last ned og last opp i Steg 2",d:"Last ned ny XLSX og dra den inn i Steg 2 i appen."},
  ]},
  {nr:"03",tittel:"Kjør analyse",ikon:"🔍",col:IND,steg:[
    {t:"Verifiser filene",d:"Appen viser kontraktsområde og dato fra begge filer. Sjekk at de stemmer."},
    {t:"Klikk Start analyse",d:"Appen sammenligner alle kategorier automatisk."},
    {t:"Les resultatene",d:"Tabellen sorteres etter størst endring. Klikk en rad for å se detaljer per vegkategori."},
  ]},
  {nr:"04",tittel:"Send til byggemøte",ikon:"✉️",col:"#7c3aed",steg:[
    {t:"Kryss av relevante rader",d:"Marker endringene du vil ta opp på byggemøtet ved å krysse av."},
    {t:"Klikk Send e-post",d:"CSV-filen lastes ned og e-postklienten åpnes med ferdig emnefelt og oversikt."},
    {t:"Legg ved CSV",d:"Finn den nedlastede filen og legg den ved e-posten."},
  ]},
];

function HjelpeModal({onLukk}) {
  const [a,setA]=useState(0);
  const s=GUIDE[a];
  return (
    <div onClick={onLukk} style={{position:"fixed",inset:0,
      background:"rgba(26,21,48,0.6)",zIndex:2000,
      display:"flex",alignItems:"center",justifyContent:"center",
      padding:"1rem",backdropFilter:"blur(4px)"}}>
      <div onClick={e=>e.stopPropagation()} className="pop-in card"
        style={{width:"100%",maxWidth:580,maxHeight:"90vh",
          display:"flex",flexDirection:"column",
          boxShadow:"0 40px 80px rgba(91,69,214,0.25)"}}>

        {/* Header */}
        <div style={{padding:"1.4rem 1.6rem 1rem",borderBottom:`1.5px solid ${BORD}`,
          display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontFamily:FB,fontWeight:800,fontSize:"1.1rem",color:INK}}>
              💡 Brukerveiledning
            </div>
            <div style={{fontFamily:FB,fontSize:"0.76rem",color:MUTED,marginTop:"0.1rem"}}>
              4 steg til ferdig analyse
            </div>
          </div>
          <button onClick={onLukk} style={{background:"#f4f2ff",border:`1.5px solid ${BORD}`,
            borderRadius:"50%",width:34,height:34,fontSize:"1rem",cursor:"pointer",
            color:SUB,display:"flex",alignItems:"center",justifyContent:"center",
            transition:"all 0.15s"}}
            onMouseEnter={e=>{e.currentTarget.style.background=IND;e.currentTarget.style.color="#fff";}}
            onMouseLeave={e=>{e.currentTarget.style.background="#f4f2ff";e.currentTarget.style.color=SUB;}}>
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div style={{display:"flex",borderBottom:`1.5px solid ${BORD}`,flexShrink:0}}>
          {GUIDE.map((g,i)=>(
            <button key={i} onClick={()=>setA(i)} style={{
              flex:1,padding:"0.85rem 0.3rem",background:"none",border:"none",
              borderBottom:`3px solid ${a===i?g.col:"transparent"}`,
              cursor:"pointer",fontFamily:FB,
              color:a===i?g.col:MUTED,
              fontWeight:a===i?700:500,fontSize:"0.7rem",
              transition:"all 0.15s"}}>
              <div style={{fontSize:"1.3rem",marginBottom:"0.2rem"}}>{g.ikon}</div>
              <div style={{letterSpacing:0.3}}>Steg {g.nr}</div>
            </button>
          ))}
        </div>

        {/* Innhold */}
        <div style={{overflowY:"auto",padding:"1.4rem 1.6rem",flex:1}}>
          <div style={{display:"flex",alignItems:"center",gap:"0.8rem",marginBottom:"1.2rem"}}>
            <div style={{width:42,height:42,borderRadius:12,flexShrink:0,
              background:`${s.col}15`,border:`1.5px solid ${s.col}33`,
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:"1.3rem"}}>
              {s.ikon}
            </div>
            <div>
              <div style={{fontFamily:FB,fontSize:"0.66rem",fontWeight:700,
                color:s.col,letterSpacing:0.8,textTransform:"uppercase"}}>STEG {s.nr}</div>
              <div style={{fontFamily:FB,fontWeight:700,fontSize:"1rem",color:INK}}>
                {s.tittel}
              </div>
            </div>
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:"0.6rem"}}>
            {s.steg.map((p,pi)=>(
              <div key={pi} style={{display:"flex",gap:"0.8rem",
                background:"#faf9ff",border:`1.5px solid ${BORD}`,
                borderRadius:12,padding:"0.85rem 1rem"}}>
                <div style={{width:26,height:26,borderRadius:7,flexShrink:0,
                  background:`${s.col}18`,border:`1.5px solid ${s.col}44`,
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontFamily:FM,fontWeight:600,fontSize:"0.72rem",color:s.col}}>
                  {pi+1}
                </div>
                <div>
                  <div style={{fontFamily:FB,fontWeight:700,fontSize:"0.84rem",color:INK,marginBottom:"0.2rem"}}>
                    {p.t}
                  </div>
                  <div style={{fontFamily:FB,fontSize:"0.79rem",color:SUB,lineHeight:1.65}}>
                    {p.d}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Navigasjon */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
            marginTop:"1.3rem",paddingTop:"1rem",borderTop:`1.5px solid ${BORD}`}}>
            <button className="btn btn-ghost btn-sm" onClick={()=>setA(Math.max(0,a-1))}
              disabled={a===0}>← Forrige</button>
            <div style={{display:"flex",gap:"0.4rem",alignItems:"center"}}>
              {GUIDE.map((_,i)=>(
                <div key={i} onClick={()=>setA(i)} style={{
                  width:a===i?22:8,height:8,borderRadius:4,
                  background:a===i?IND:BORD,cursor:"pointer",transition:"all 0.2s"}}/>
              ))}
            </div>
            {a<GUIDE.length-1
              ? <button className="btn btn-primary btn-sm" onClick={()=>setA(a+1)}>Neste →</button>
              : <button className="btn btn-primary btn-sm" onClick={onLukk}>
                  <span className="stamp-in" style={{display:"inline-block"}}>✓</span> Start appen
                </button>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   MODUSVELGER
═══════════════════════════════════════════════════════════ */
function Modusvelger({onVelg}) {
  return (
    <div className="anim-in" style={{maxWidth:640,margin:"4rem auto 0",padding:"0 1rem"}}>
      <div style={{textAlign:"center",marginBottom:"2.5rem"}}>
        <div style={{fontSize:"3.5rem",marginBottom:"0.6rem"}}>🛣️</div>
        <h1 style={{fontFamily:FB,fontWeight:800,fontSize:"1.9rem",color:INK,
          letterSpacing:-0.5,marginBottom:"0.5rem"}}>
          Endringsmelding-Appen
        </h1>
        <p style={{fontFamily:FB,fontSize:"0.9rem",color:SUB,lineHeight:1.7}}>
          Velg hvilken rapporttype du vil analysere
        </p>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"1.2rem"}}>
        {/* V2 */}
        <div className="card card-lift" onClick={()=>onVelg("v2")}
          style={{padding:"2rem 1.5rem",textAlign:"center",cursor:"pointer",
            border:`2px solid ${BORD}`,transition:"all 0.18s"}}
          onMouseEnter={e=>{e.currentTarget.style.borderColor=IND;e.currentTarget.style.boxShadow=`0 8px 28px ${IND}22`;}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor=BORD;e.currentTarget.style.boxShadow="";}}>
          <div style={{fontSize:"2.8rem",marginBottom:"0.8rem"}}>📊</div>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:"1.1rem",color:INK,marginBottom:"0.4rem"}}>
            V2-analyse
          </div>
          <div style={{fontFamily:FB,fontSize:"0.78rem",color:SUB,lineHeight:1.6}}>
            Aggregert mengdeoversikt per vegkategori. Sammenlign to V2-rapporter og finn endringer.
          </div>
          <div style={{marginTop:"1rem"}}>
            <span style={{fontFamily:FB,fontSize:"0.7rem",fontWeight:600,
              background:INDL,color:IND,border:`1px solid #c4b8f8`,
              borderRadius:20,padding:"3px 12px"}}>
              Oversiktsnivå
            </span>
          </div>
        </div>

        {/* V4 */}
        <div className="card card-lift" onClick={()=>onVelg("v4")}
          style={{padding:"2rem 1.5rem",textAlign:"center",cursor:"pointer",
            border:`2px solid ${BORD}`,transition:"all 0.18s"}}
          onMouseEnter={e=>{e.currentTarget.style.borderColor=GRN;e.currentTarget.style.boxShadow=`0 8px 28px ${GRN}22`;}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor=BORD;e.currentTarget.style.boxShadow="";}}>
          <div style={{fontSize:"2.8rem",marginBottom:"0.8rem"}}>🗺️</div>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:"1.1rem",color:INK,marginBottom:"0.4rem"}}>
            V4-analyse
          </div>
          <div style={{fontFamily:FB,fontSize:"0.78rem",color:SUB,lineHeight:1.6}}>
            Detaljert per objekt. Se hvert enkelt endret objekt med direktelenke til Vegkart.
          </div>
          <div style={{marginTop:"1rem"}}>
            <span style={{fontFamily:FB,fontSize:"0.7rem",fontWeight:600,
              background:`${GRN}15`,color:GRN,border:`1px solid ${GRN}44`,
              borderRadius:20,padding:"3px 12px"}}>
              Objektnivå + Kart
            </span>
          </div>
        </div>
      </div>

      <div style={{textAlign:"center",marginTop:"1.5rem",fontFamily:FB,
        fontSize:"0.74rem",color:MUTED}}>
        Tips: Bruk V2 for oversikten, deretter V4 for å se detaljene i kartet
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   HOVED-APP
═══════════════════════════════════════════════════════════ */
export default function App() {
  const [modus,setModus]         = useState(null); // null | "v2" | "v4"
  const [steg,setSteg]           = useState(1);
  const [grunnlag,setGrunnlag]   = useState(null);
  const [nav,setNav]             = useState(null);
  const [res,setRes]             = useState(null);
  const [hjelp,setHjelp]         = useState(true);

  // V4-tilstand
  const [v4Grunnlag,setV4Grunnlag] = useState(null);
  const [v4Nav,setV4Nav]           = useState(null);
  const [v4Res,setV4Res]           = useState(null);
  const [v4Steg,setV4Steg]         = useState(1);

  function reset(){
    setModus(null);
    setSteg(1);setGrunnlag(null);setNav(null);setRes(null);
    setV4Steg(1);setV4Grunnlag(null);setV4Nav(null);setV4Res(null);
    setHjelp(false);
  }

  return (
    <div style={{minHeight:"100vh",background:BG,display:"flex",
      flexDirection:"column",fontFamily:FB}}>
      <style>{CSS}</style>
      {hjelp&&modus==="v2"&&<HjelpeModal onLukk={()=>setHjelp(false)}/>}

      <Topbar onHjelp={()=>modus==="v2"&&setHjelp(true)} modus={modus} onModus={reset}/>

      {modus==="v2"&&<HPBar steg={steg}/>}
      {modus==="v4"&&<HPBar steg={v4Steg} total={3} labels={["V4 Grunnlag","V4 Nåværende","Ferdig!"]}/>}

      <div style={{flex:1,padding:"2.2rem 1.5rem",
        maxWidth:1200,margin:"0 auto",width:"100%"}}>

        {/* MODUSVELGER */}
        {!modus&&<Modusvelger onVelg={m=>{setModus(m);setHjelp(m==="v2");}}/>}

        {/* V2-FLYT */}
        {modus==="v2"&&steg===1&&(
          <FilSteg nr={1} onNeste={d=>{setGrunnlag(d);setSteg(2);}}/>
        )}
        {modus==="v2"&&steg===2&&(
          <FilSteg nr={2}
            forrigeInfo={grunnlag?.meta?.omrade
              ?`${grunnlag.meta.omrade}${grunnlag.meta.gyldighetsdato?" · "+grunnlag.meta.gyldighetsdato:""}`
              :grunnlag?.filnavn}
            onNeste={d=>{setNav(d);setSteg(3);}}
            onTilbake={()=>setSteg(1)}/>
        )}
        {modus==="v2"&&steg===3&&grunnlag&&nav&&(
          <Steg3 grunnlag={grunnlag} navaerende={nav}
            onResultat={r=>{setRes(r);setSteg(4);}}
            onTilbake={()=>setSteg(2)}/>
        )}
        {modus==="v2"&&steg===4&&res&&(
          <Resultater data={res} grunnlag={grunnlag} navaerende={nav} onNy={reset}/>
        )}

        {/* V4-FLYT */}
        {modus==="v4"&&v4Steg===1&&(
          <V4FilSteg nr={1}
            onNeste={d=>{setV4Grunnlag(d);setV4Steg(2);}}
            onTilbake={reset}/>
        )}
        {modus==="v4"&&v4Steg===2&&(
          <V4FilSteg nr={2}
            forrigeInfo={v4Grunnlag?.meta?.omrade
              ?`${v4Grunnlag.meta.omrade}${v4Grunnlag.meta.gyldighetsdato?" · "+v4Grunnlag.meta.gyldighetsdato:""}`
              :v4Grunnlag?.filnavn}
            onNeste={d=>{
              setV4Nav(d);
              setV4Res(kjorV4Diff(v4Grunnlag,d));
              setV4Steg(3);
            }}
            onTilbake={()=>setV4Steg(1)}/>
        )}
        {modus==="v4"&&v4Steg===3&&v4Res&&(
          <V4Resultater data={v4Res} grunnlag={v4Grunnlag} navaerende={v4Nav} onNy={reset}/>
        )}
      </div>

      <div style={{background:WHITE,borderTop:`1.5px solid ${BORD}`,
        padding:"0.7rem 1.8rem",display:"flex",justifyContent:"space-between"}}>
        <span style={{fontFamily:FB,fontSize:"0.7rem",color:MUTED}}>
          Endringsmelding-Appen · NVDB {modus==="v4"?"V4 Detaljert":"V2 Aggregert"}
        </span>
        <a href={NVDB_PORTAL} target="_blank" rel="noreferrer"
          style={{fontFamily:FB,fontSize:"0.7rem",color:IND,textDecoration:"none",fontWeight:600}}>
          NVDB-portalen ↗
        </a>
      </div>
    </div>
  );
}
