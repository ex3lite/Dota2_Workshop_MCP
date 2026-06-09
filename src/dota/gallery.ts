// Build a self-contained, interactive preview gallery served over HTTP (and a tunnel):
//   - PARTICLES: replayed live in a <canvas> as additive billboards driven by the real vpcf
//     params (sprite, emission, lifespan, size-over-life, colour start→end, gravity). Not the
//     engine's renderer, but it MOVES and GLOWS so you can actually judge/choose an effect.
//   - MODELS: interactive 3D via <model-viewer> (GLB).
//   - SOUNDS: a real <audio> player per sound (you choose by HEARING, not by waveform).
//   - TEXTURES: the decoded PNG.
import type { ParticleSpec } from "./vpcf.js";

export interface GalleryData {
  title: string;
  particles: { id: string; name: string; game: string; sprite?: string; spec: ParticleSpec }[];
  models: { id: string; name: string; game: string; glb: string }[];
  sounds: { id: string; name: string; game: string; src: string; fmt: string; dur: string }[];
  textures: { id: string; name: string; game: string; src: string }[];
  modelViewerSrc?: string; // local "model-viewer.min.js" (preferred) or a CDN fallback URL
}

export const MODEL_VIEWER_VERSION = "3.5.0";
export const MODEL_VIEWER_CDN = `https://ajax.googleapis.com/ajax/libs/model-viewer/${MODEL_VIEWER_VERSION}/model-viewer.min.js`;

// The canvas particle engine + bootstrap. Kept as a plain (non-template) JS string written
// to engine.js, so the page's own template literals don't clash with TS interpolation.
export const ENGINE_JS = `(function(){
  function lerp(a,b,t){return a+(b-a)*t;}
  function loadImg(src){return new Promise(function(res){var i=new Image();i.onload=function(){res(i);};i.onerror=function(){res(null);};i.src=src;});}
  function fallbackSprite(){var c=document.createElement('canvas');c.width=c.height=64;var x=c.getContext('2d');var g=x.createRadialGradient(32,32,0,32,32,32);g.addColorStop(0,'rgba(255,255,255,1)');g.addColorStop(0.4,'rgba(255,255,255,0.55)');g.addColorStop(1,'rgba(255,255,255,0)');x.fillStyle=g;x.fillRect(0,0,64,64);return c;}
  function tint(img,r,g,b){var c=document.createElement('canvas');c.width=img.width||64;c.height=img.height||64;var x=c.getContext('2d');x.drawImage(img,0,0,c.width,c.height);x.globalCompositeOperation='multiply';x.fillStyle='rgb('+(r|0)+','+(g|0)+','+(b|0)+')';x.fillRect(0,0,c.width,c.height);x.globalCompositeOperation='destination-in';x.drawImage(img,0,0,c.width,c.height);return c;}
  function start(canvas, spec, img){
    var ctx=canvas.getContext('2d');var W=canvas.width,H=canvas.height;var cx=W/2,cy=H*0.6;
    var PX=Math.min(W,H)/300;
    var STEPS=8, tints=[];
    for(var i=0;i<STEPS;i++){var t=i/(STEPS-1);tints.push(tint(img,lerp(spec.colorStart[0],spec.colorEnd[0],t),lerp(spec.colorStart[1],spec.colorEnd[1],t),lerp(spec.colorStart[2],spec.colorEnd[2],t)));}
    var ps=[],last=performance.now(),loopT=0,emitAcc=0;
    var period=spec.lifespan+0.5, maxAlive=Math.min(spec.maxParticles,140);
    function spawn(){if(ps.length>=maxAlive*1.5)return;var a=Math.random()*Math.PI*2;var spd=spec.radius*PX*(0.5+Math.random()*1.0);ps.push({x:cx+(Math.random()-0.5)*spec.radius*PX*0.4,y:cy+(Math.random()-0.5)*spec.radius*PX*0.4,vx:Math.cos(a)*spd*0.5,vy:Math.sin(a)*spd*0.5-spec.radius*PX*0.15,age:0,life:spec.lifespan*(0.7+Math.random()*0.6),roll:Math.random()*Math.PI*2,rs:(Math.random()-0.5)*2.5});}
    function frame(now){
      var dt=Math.min(0.05,(now-last)/1000);last=now;loopT+=dt;var tin=loopT%period;
      if(spec.burst){if(tin<dt){for(var k=0;k<spec.burst;k++)spawn();}}
      if(spec.emitRate){var dur=spec.emitDuration||period*0.6;if(tin<dur){emitAcc+=spec.emitRate*dt;while(emitAcc>=1){emitAcc-=1;spawn();}}}
      var ay=-spec.gravityZ*PX*0.25;
      for(var i=ps.length-1;i>=0;i--){var p=ps[i];p.age+=dt;if(p.age>=p.life){ps.splice(i,1);continue;}p.vy+=ay*dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.roll+=p.rs*dt;}
      ctx.globalCompositeOperation='source-over';ctx.fillStyle='#05070d';ctx.fillRect(0,0,W,H);
      ctx.globalCompositeOperation=spec.additive?'lighter':'source-over';
      for(var i=0;i<ps.length;i++){var p=ps[i];var t=p.age/p.life;var sc=lerp(spec.startScale,spec.endScale,t);var size=spec.radius*sc*PX*2;if(size<1)continue;var fade=Math.min(1,t/0.12)*(1-Math.max(0,(t-0.55)/0.45));if(fade<=0)continue;ctx.globalAlpha=Math.max(0,Math.min(1,spec.baseAlpha*fade));var ti=tints[Math.min(STEPS-1,Math.floor(t*STEPS))];ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.roll);ctx.drawImage(ti,-size/2,-size/2,size,size);ctx.restore();}
      ctx.globalAlpha=1;if(canvas._run)requestAnimationFrame(frame);
    }
    canvas._run=true;requestAnimationFrame(frame);
  }
  var io=new IntersectionObserver(function(es){es.forEach(function(e){var cv=e.target;if(e.isIntersecting&&!cv._init){cv._init=true;var spec=JSON.parse(cv.getAttribute('data-spec'));var src=cv.getAttribute('data-sprite');(src?loadImg(src):Promise.resolve(null)).then(function(img){start(cv,spec,img||fallbackSprite());});}cv._run=e.isIntersecting&&cv._init?cv._run:cv._run;});},{rootMargin:'100px'});
  document.querySelectorAll('canvas.particle').forEach(function(cv){io.observe(cv);});

  // --- model loaders: show a spinner until each model-viewer finishes loading ---
  document.querySelectorAll('model-viewer').forEach(function(mv){
    var card = mv.closest('.card');
    mv.addEventListener('load', function(){ if(card) card.classList.remove('loading'); });
    mv.addEventListener('error', function(){ if(card){ card.classList.remove('loading'); card.classList.add('load-error'); } });
  });

  // --- selection: toggle LOCALLY, commit only on "Отправить" (submit) ---
  var picked = {}; // id -> true
  var SEL_BASE = 'Отправить выбор';
  function ids(){ return Object.keys(picked); }
  function esc(s){ return String(s).replace(/[&<>]/g,function(c){return c==='&'?'&amp;':c==='<'?'&lt;':'&gt;';}); }
  function refresh(){
    var list = ids(), n = list.length;
    document.querySelectorAll('.card').forEach(function(c){ c.classList.toggle('selected', !!picked[c.getAttribute('data-id')]); });
    var cnt=document.getElementById('count'); if(cnt) cnt.textContent=n;
    var chips=document.getElementById('chips'); if(chips) chips.innerHTML=list.map(function(id){return '<span class="chip" data-id="'+esc(id)+'">'+esc(id)+' ✕</span>';}).join('');
    var tray=document.getElementById('tray'); if(tray) tray.classList.toggle('show', n>0);
    var sub=document.getElementById('submit'); if(sub){ sub.disabled=n===0; sub.textContent = n? (SEL_BASE+' ('+n+') →') : (SEL_BASE+' →'); }
  }
  document.addEventListener('click', function(e){
    var b = e.target && e.target.closest ? e.target.closest('.sel') : null;
    if(b){ e.preventDefault(); var id=b.getAttribute('data-id'); if(picked[id]) delete picked[id]; else picked[id]=true; refresh(); return; }
    var chip = e.target && e.target.closest ? e.target.closest('.chip') : null;
    if(chip){ delete picked[chip.getAttribute('data-id')]; refresh(); return; }
  });
  var clr=document.getElementById('clearbtn'); if(clr) clr.onclick=function(){ picked={}; refresh(); };
  function toast(msg,bad){ var t=document.getElementById('toast'); if(!t)return; t.textContent=msg;
    t.style.background=bad?'#331515':'#10331f'; t.style.color=bad?'#f3a3a3':'#9ff3c2'; t.style.borderColor=bad?'#7d2c2c':'#2c7d52';
    t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(function(){t.classList.remove('show');},2600); }
  var sub=document.getElementById('submit');
  if(sub) sub.onclick=function(){
    var list=ids(); if(!list.length) return;
    sub.disabled=true; sub.textContent='Отправляю…';
    fetch('/api/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:list})})
      .then(function(r){return r.json();})
      .then(function(){ toast('Отправлено агенту ✓  ('+list.length+')'); sub.textContent='Отправлено ✓'; setTimeout(refresh,1600); })
      .catch(function(){ toast('Ошибка отправки',1); refresh(); });
  };
  // reflect a previously submitted selection (e.g. after refresh)
  fetch('/api/selections').then(function(r){return r.json();}).then(function(d){ (d.ids||[]).forEach(function(id){picked[id]=true;}); refresh(); }).catch(function(){ refresh(); });
})();`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildGalleryHtml(d: GalleryData): string {
  const section = (key: string, title: string, sub: string, count: number, body: string) =>
    body.trim()
      ? `<section><h2>${esc(title)} <span class="pill">${count}</span> <span class="sub">${esc(sub)}</span></h2><div class="grid">${body}</div></section>`
      : "";

  const head = (id: string) =>
    `<span class="id">${esc(id)}</span><button class="sel" data-id="${esc(id)}" aria-label="select"><span class="t">выбрать</span></button>`;
  const foot = (name: string, meta: string) =>
    `<div class="nm" title="${esc(name)}">${esc(name)}</div><div class="mt">${esc(meta)}</div>`;

  const particleCards = d.particles
    .map(
      (p) => `<div class="card" data-id="${esc(p.id)}">${head(p.id)}<div class="view"><canvas class="particle" width="260" height="220"
        data-spec='${esc(JSON.stringify(p.spec))}' ${p.sprite ? `data-sprite="${esc(p.sprite)}"` : ""}></canvas></div>
      ${foot(p.name, p.game + (p.sprite ? "" : " · generic sprite"))}</div>`,
    )
    .join("");

  const modelCards = d.models
    .map(
      (m) => `<div class="card mdl loading" data-id="${esc(m.id)}">${head(m.id)}<div class="view"><model-viewer src="${esc(m.glb)}"
        camera-controls auto-rotate disable-zoom rotation-per-second="22deg" interaction-prompt="none" loading="lazy" reveal="auto"
        shadow-intensity="0.9" exposure="1.05"></model-viewer><div class="spin"></div></div>${foot(m.name, m.game)}</div>`,
    )
    .join("");

  const soundCards = d.sounds
    .map(
      (s) => `<div class="card snd" data-id="${esc(s.id)}">${head(s.id)}${foot(s.name, s.game + " · " + s.fmt + " · " + s.dur)}
      <audio controls preload="none" src="${esc(s.src)}"></audio></div>`,
    )
    .join("");

  const textureCards = d.textures
    .map(
      (t) => `<div class="card" data-id="${esc(t.id)}">${head(t.id)}<div class="media"><img loading="lazy" src="${esc(t.src)}"></div>${foot(t.name, t.game)}</div>`,
    )
    .join("");

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.title)}</title>
<script type="module" src="${esc(d.modelViewerSrc || MODEL_VIEWER_CDN)}"></script>
<style>
  :root{color-scheme:dark;--bg:#0a0d13;--panel:#131a28;--panel2:#0e1422;--bd:#222c40;--bd2:#2c374f;--tx:#d8dde9;--mut:#8a93a8;--acc:#35d07f;--gold:#ffce6b}
  *{box-sizing:border-box}
  body{background:radial-gradient(1200px 600px at 70% -10%,#10182a 0%,var(--bg) 60%);color:var(--tx);
    font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px 18px 120px;-webkit-font-smoothing:antialiased}
  h1{font-size:21px;font-weight:750;margin:2px 0 2px;letter-spacing:-.2px}
  .lead{color:var(--mut);margin:0 0 8px;max-width:78ch;font-size:13.5px}
  h2{font-size:15px;font-weight:700;margin:30px 0 12px;display:flex;align-items:center;gap:9px}
  .pill{background:#1b2336;color:#aeb8cd;border:1px solid var(--bd);border-radius:999px;padding:1px 9px;font-size:12px;font-weight:700}
  .sub{color:var(--mut);font-weight:400;font-size:12.5px;margin-left:2px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
  .card{position:relative;background:linear-gradient(180deg,var(--panel) 0%,var(--panel2) 100%);border:1px solid var(--bd);
    border-radius:13px;overflow:hidden;transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease;
    animation:rise .34s ease both}
  @keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
  .card:hover{transform:translateY(-3px);border-color:var(--bd2);box-shadow:0 10px 26px -12px rgba(0,0,0,.7)}
  .view{position:relative;height:210px;background:#05070d}
  canvas.particle{display:block;width:100%;height:210px;background:#05070d}
  .view model-viewer{width:100%;height:210px;background:radial-gradient(120% 120% at 50% 20%,#141d30 0%,#05070d 70%);--poster-color:transparent}
  .media{height:210px;display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(#151b29 0% 25%,#0d1320 0% 50%) 50%/20px 20px}
  .media img{max-width:100%;max-height:210px;object-fit:contain}
  .nm{padding:8px 10px 0;font-weight:650;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mt{padding:1px 10px 10px;color:var(--mut);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .card.snd{padding:11px}.card.snd .nm,.card.snd .mt{padding:0}.card.snd audio{width:100%;margin-top:9px;height:34px}
  .id{position:absolute;top:8px;left:8px;z-index:5;background:var(--gold);color:#181203;font-weight:800;
    border-radius:8px;padding:2px 9px;font-size:13px;letter-spacing:.4px;box-shadow:0 2px 6px rgba(0,0,0,.45)}
  .sel{position:absolute;top:8px;right:8px;z-index:6;display:flex;align-items:center;gap:5px;background:#0e1626cc;color:#cfd6e6;
    border:1px solid var(--bd2);border-radius:9px;padding:4px 10px;font-size:12px;font-weight:650;cursor:pointer;
    backdrop-filter:blur(4px);transition:all .14s ease}
  .sel::before{content:"+";font-weight:800;font-size:14px;line-height:1}
  .sel:hover{background:#1a2740;border-color:#3a486a}
  .card.selected{border-color:var(--acc);box-shadow:0 0 0 2px rgba(53,208,127,.45),0 10px 26px -12px rgba(0,0,0,.7)}
  .card.selected .sel{background:var(--acc);color:#04130a;border-color:var(--acc)}
  .card.selected .sel::before{content:"✓"}
  .card.selected .sel .t{display:none}
  .card.selected .sel::after{content:"выбрано"}
  /* model loader */
  .spin{position:absolute;top:50%;left:50%;width:26px;height:26px;margin:-13px 0 0 -13px;border:3px solid #28324a;
    border-top-color:var(--acc);border-radius:50%;animation:spin .8s linear infinite}
  .mdl:not(.loading) .spin{display:none}
  .mdl.load-error .spin{display:none}
  @keyframes spin{to{transform:rotate(360deg)}}
  /* bottom selection tray */
  #tray{position:fixed;left:50%;bottom:18px;transform:translate(-50%,160%);z-index:40;display:flex;align-items:center;gap:14px;
    max-width:min(960px,94vw);background:#0f1726f2;border:1px solid var(--bd2);border-radius:16px;padding:11px 14px;
    box-shadow:0 18px 50px -12px rgba(0,0,0,.8);backdrop-filter:blur(10px);transition:transform .26s cubic-bezier(.2,.8,.2,1);opacity:.0}
  #tray.show{transform:translate(-50%,0);opacity:1}
  .tinfo{display:flex;align-items:center;gap:10px;min-width:0;overflow:hidden}
  .tn{font-weight:700;white-space:nowrap}.tn b{color:var(--acc);font-size:17px}
  .chips{display:flex;gap:6px;overflow-x:auto;max-width:46vw;padding-bottom:1px}
  .chip{flex:0 0 auto;background:#1a2336;border:1px solid var(--bd2);color:var(--gold);font-weight:700;border-radius:8px;
    padding:3px 9px;font-size:12.5px;cursor:pointer;white-space:nowrap}
  .chip:hover{background:#26314a;color:#fff}
  .tact{display:flex;gap:9px;margin-left:auto}
  .ghost{background:transparent;color:var(--mut);border:1px solid var(--bd2);border-radius:10px;padding:8px 12px;cursor:pointer;font-size:13px;font-weight:600}
  .ghost:hover{color:var(--tx);border-color:#3a486a}
  .primary{background:linear-gradient(180deg,#3ee089,#23b76a);color:#04130a;border:0;border-radius:10px;padding:9px 16px;
    cursor:pointer;font-size:14px;font-weight:800;box-shadow:0 6px 16px -6px rgba(53,208,127,.6);transition:filter .14s,transform .1s}
  .primary:hover{filter:brightness(1.07)}.primary:active{transform:translateY(1px)}
  .primary:disabled{background:#222c40;color:#5b657c;box-shadow:none;cursor:not-allowed}
  #toast{position:fixed;left:50%;bottom:84px;transform:translate(-50%,12px);z-index:50;background:#10331f;color:#9ff3c2;
    border:1px solid #2c7d52;border-radius:11px;padding:9px 16px;font-weight:700;opacity:0;pointer-events:none;transition:all .25s}
  #toast.show{opacity:1;transform:translate(-50%,0)}
  @media(max-width:560px){.chips{max-width:34vw}.lead{display:none}}
</style></head><body>
<h1>${esc(d.title)}</h1>
<p class="lead">Декодировано вне движка (ValveResourceFormat) — без запуска Доты. Партиклы — живая анимация из реальных .vpcf-параметров (аппроксимация, не движковый рендер); модели — интерактивное 3D; звуки — с плеером. Отметь карточки кнопкой «выбрать» и нажми «Отправить» — выбор уйдёт агенту. Можно и просто назвать ID (P#/M#/S#/T#).</p>
${section("particles", "Партиклы", "анимация в цикле", d.particles.length, particleCards)}
${section("models", "Модели", "тяни мышкой, чтобы вращать", d.models.length, modelCards)}
${section("sounds", "Звуки", "нажми play", d.sounds.length, soundCards)}
${section("textures", "Текстуры", "", d.textures.length, textureCards)}
<div id="tray">
  <div class="tinfo"><span class="tn"><b id="count">0</b> выбрано</span><div id="chips" class="chips"></div></div>
  <div class="tact"><button id="clearbtn" class="ghost">Очистить</button><button id="submit" class="primary" disabled>Отправить выбор →</button></div>
</div>
<div id="toast"></div>
<script src="engine.js"></script>
</body></html>`;
}
