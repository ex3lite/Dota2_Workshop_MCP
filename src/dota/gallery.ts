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
}

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

  // --- click-to-select hook: a card's "выбрать" button POSTs its ID to the server ---
  function renderBar(ids){
    var el=document.getElementById('picked'); if(el) el.textContent = ids.length ? ids.join(', ') : '— ничего —';
    document.querySelectorAll('.card').forEach(function(c){ c.classList.toggle('selected', ids.indexOf(c.getAttribute('data-id'))>=0); });
  }
  function loadSel(){ fetch('/api/selections').then(function(r){return r.json();}).then(function(d){renderBar(d.ids||[]);}).catch(function(){}); }
  document.addEventListener('click', function(e){
    var b = e.target && e.target.closest ? e.target.closest('.sel') : null;
    if(!b) return;
    e.preventDefault();
    var id=b.getAttribute('data-id');
    var card=b.closest('.card');
    var on=!(card && card.classList.contains('selected'));
    fetch('/api/pick',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,on:on})})
      .then(function(r){return r.json();}).then(function(d){renderBar(d.ids||[]);}).catch(function(){});
  });
  var clr=document.getElementById('clear'); if(clr) clr.onclick=function(){ fetch('/api/clear',{method:'POST'}).then(function(r){return r.json();}).then(function(d){renderBar(d.ids||[]);}); };
  var cp=document.getElementById('copy'); if(cp) cp.onclick=function(){ var t=(document.getElementById('picked')||{}).textContent||''; if(navigator.clipboard) navigator.clipboard.writeText(t); cp.textContent='Скопировано'; setTimeout(function(){cp.textContent='Копировать ID';},1200); };
  loadSel();
})();`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildGalleryHtml(d: GalleryData): string {
  const section = (title: string, sub: string, body: string) =>
    body.trim() ? `<h2>${esc(title)} <span class="sub">${esc(sub)}</span></h2><div class="grid">${body}</div>` : "";

  const badge = (id: string) => `<span class="id" title="ID ассета">${esc(id)}</span>`;
  const sel = (id: string) => `<button class="sel" data-id="${esc(id)}" title="Выбрать / снять">＋ выбрать</button>`;

  const particleCards = d.particles
    .map(
      (p) => `<div class="card" data-id="${esc(p.id)}">${badge(p.id)}${sel(p.id)}<canvas class="particle" width="260" height="220"
        data-spec='${esc(JSON.stringify(p.spec))}' ${p.sprite ? `data-sprite="${esc(p.sprite)}"` : ""}></canvas>
      <div class="nm" title="${esc(p.name)}">${esc(p.name)}</div><div class="mt">${esc(p.game)}${p.sprite ? "" : " · generic sprite"}</div></div>`,
    )
    .join("");

  const modelCards = d.models
    .map(
      (m) => `<div class="card" data-id="${esc(m.id)}">${badge(m.id)}${sel(m.id)}<model-viewer src="${esc(m.glb)}" camera-controls auto-rotate disable-zoom
        shadow-intensity="1" exposure="1.1" style="width:100%;height:220px;background:#05070d"></model-viewer>
      <div class="nm" title="${esc(m.name)}">${esc(m.name)}</div><div class="mt">${esc(m.game)}</div></div>`,
    )
    .join("");

  const soundCards = d.sounds
    .map(
      (s) => `<div class="card snd" data-id="${esc(s.id)}">${badge(s.id)}${sel(s.id)}<div class="nm" title="${esc(s.name)}">${esc(s.name)}</div>
      <div class="mt">${esc(s.game)} · ${esc(s.fmt)} · ${esc(s.dur)}</div>
      <audio controls preload="none" src="${esc(s.src)}"></audio></div>`,
    )
    .join("");

  const textureCards = d.textures
    .map(
      (t) => `<div class="card" data-id="${esc(t.id)}">${badge(t.id)}${sel(t.id)}<div class="media"><img loading="lazy" src="${esc(t.src)}"></div>
      <div class="nm" title="${esc(t.name)}">${esc(t.name)}</div><div class="mt">${esc(t.game)}</div></div>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.title)}</title>
<script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js"></script>
<style>
  :root{color-scheme:dark}
  body{background:#0a0d14;color:#cdd3e0;font:15px/1.45 system-ui,Segoe UI,sans-serif;margin:0;padding:18px 18px 60px}
  h1{font-size:20px;margin:0 0 2px} h2{font-size:16px;margin:26px 0 10px;border-bottom:1px solid #1c2434;padding-bottom:6px}
  .sub{color:#7c879c;font-weight:400;font-size:13px}
  .lead{color:#8b93a7;margin:0 0 6px;max-width:70ch}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
  .card{position:relative;background:#121724;border:1px solid #222b3d;border-radius:10px;overflow:hidden}
  .id{position:absolute;top:7px;left:7px;z-index:5;background:#ffd27a;color:#10131c;font-weight:800;
     border-radius:7px;padding:2px 9px;font-size:14px;letter-spacing:.5px;box-shadow:0 1px 4px rgba(0,0,0,.5)}
  canvas.particle{display:block;width:100%;height:220px;background:#05070d}
  .media{height:220px;display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(#161b27 0% 25%,#0e121c 0% 50%) 50%/22px 22px}
  .media img{max-width:100%;max-height:220px}
  .nm{padding:7px 9px 0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mt{padding:0 9px 9px;color:#8b93a7;font-size:12px}
  .card.snd{padding:10px}.card.snd .nm,.card.snd .mt{padding:0}.card.snd audio{width:100%;margin-top:8px}
  .sel{position:absolute;top:7px;right:7px;z-index:6;background:#1c2434;color:#cdd3e0;border:1px solid #2a3346;
     border-radius:7px;padding:3px 9px;font-size:12px;font-weight:600;cursor:pointer}
  .sel:hover{background:#26314a}
  .card.selected{border-color:#3ad17a;box-shadow:0 0 0 2px rgba(58,209,122,.5)}
  .card.selected .sel{background:#3ad17a;color:#05140b;border-color:#3ad17a}
  #bar{position:sticky;top:0;z-index:20;background:#0a0d14ee;backdrop-filter:blur(6px);padding:10px 4px;margin:-4px -4px 8px;
     border-bottom:1px solid #1c2434;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  #bar b{color:#3ad17a}#picked{color:#ffd27a;font-weight:700}
  #bar button{background:#1c2434;color:#cdd3e0;border:1px solid #2a3346;border-radius:7px;padding:4px 10px;cursor:pointer;font-size:13px}
  #bar .ok{background:#3ad17a;color:#05140b;border-color:#3ad17a;font-weight:700}
</style></head><body>
<div id="bar">
  <b>✓ Выбор:</b> <span id="picked">— ничего —</span>
  <button id="copy">Копировать ID</button>
  <button id="clear">Снять всё</button>
  <span class="mt" style="margin-left:auto">Жми «выбрать» на карточке → выбор уходит агенту</span>
</div>
<h1>${esc(d.title)}</h1>
<p class="lead">Decoded out-of-engine via ValveResourceFormat — no Dota launch. Particles are replayed from their real .vpcf parameters as additive billboards (an approximation, not the engine renderer); models are interactive 3D; sounds have a player. <b style="color:#ffd27a">Кликай «выбрать»</b> на нужных карточках — выбор сразу уходит агенту (или назови ID: P# / M# / S# / T#).</p>
${section("Particles", `${d.particles.length} — drag nothing, they loop automatically`, particleCards)}
${section("Models", `${d.models.length} — drag to rotate`, modelCards)}
${section("Sounds", `${d.sounds.length} — press play`, soundCards)}
${section("Textures", `${d.textures.length}`, textureCards)}
<script src="engine.js"></script>
</body></html>`;
}
