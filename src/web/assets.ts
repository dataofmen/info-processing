export const CSS = `
:root{--bg:#fbfaf8;--panel:#fff;--ink:#1d1d1f;--sub:#5f6368;--line:#e7e4df;--acc:#2f5bea;--acc-soft:#eef2ff;
--topic:#7c3aed;--claim:#0f766e;--source:#b45309;--raw:#64748b;--warn:#c2410c;--r:10px}
@media (prefers-color-scheme:dark){:root{--bg:#141517;--panel:#1c1d20;--ink:#ececec;--sub:#9aa0a6;--line:#2c2e33;--acc:#7c9cff;--acc-soft:#1f2640;
--topic:#b196ff;--claim:#4fd1c5;--source:#f0a95a;--raw:#94a3b8;--warn:#fb923c}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 "Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,system-ui,sans-serif;word-break:keep-all;overflow-wrap:anywhere}
a{color:inherit;text-decoration:none}a:hover{color:var(--acc)}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px}
.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.bar{display:flex;align-items:center;gap:14px;height:56px}
.brand{font-weight:800;letter-spacing:-.02em;font-size:17px}
.sf{flex:1;max-width:520px}.sf input{width:100%;height:36px;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:999px;padding:0 14px;font:inherit}
.sf input:focus{outline:2px solid var(--acc);outline-offset:-1px}
nav{display:flex;gap:2px}nav a{padding:6px 10px;border-radius:8px;color:var(--sub);font-size:14px}nav a.on,nav a:hover{background:var(--acc-soft);color:var(--acc)}
@media (max-width:720px){.bar{flex-wrap:wrap;height:auto;padding:8px 16px;gap:8px}.sf{order:3;flex-basis:100%;max-width:none}nav{margin-left:auto}nav a{padding:6px 7px}}
main.wrap{padding-top:22px;padding-bottom:60px}
h1.h{font-size:22px;letter-spacing:-.02em;margin:4px 0 14px}h1 small,h2 small,h4 small{color:var(--sub);font-weight:500;font-size:.75em;margin-left:4px}
h2{font-size:16px;margin:0 0 10px;display:flex;align-items:baseline;gap:8px}.more{margin-left:auto;font-size:13px;color:var(--sub);font-weight:500}
.muted{color:var(--sub)}.warn{color:var(--warn)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:16px}
.stats div{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px}
.stats b{display:block;font-size:24px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.stats span{color:var(--sub);font-size:13px}
.alert{display:block;background:color-mix(in srgb,var(--warn) 12%,var(--panel));border:1px solid color-mix(in srgb,var(--warn) 35%,transparent);color:var(--warn);padding:10px 14px;border-radius:var(--r);margin-bottom:14px;font-weight:600}
.capture{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px}.capture input[type=url]{flex:2;min-width:220px}.capture input[name=memo]{flex:1;min-width:140px}
.capture input,button{height:38px;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:0 12px;font:inherit}
.capture label{display:flex;align-items:center;gap:4px;color:var(--sub);font-size:14px}
button{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600;cursor:pointer}button.ghost{background:transparent;color:var(--acc)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:26px}@media (max-width:860px){.cols{grid-template-columns:1fr}}
.list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.row{background:var(--panel);border:1px solid var(--line);border-radius:var(--r)}.row>a,.row>div{display:block;padding:11px 14px}.row:has(>div){padding:11px 14px}.row:has(>div)>div{padding:0}
.row:hover{border-color:color-mix(in srgb,var(--acc) 40%,var(--line))}
.rt{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.ttl{font-weight:600;letter-spacing:-.01em}
.rs{color:var(--sub);font-size:13.5px;margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rm{color:var(--sub);font-size:12px;margin-top:4px}
.badge{display:inline-block;font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;border:1px solid currentColor;line-height:1.5;white-space:nowrap}
.t-topic{color:var(--topic)}.t-claim{color:var(--claim)}.t-source{color:var(--source)}.t-raw{color:var(--raw)}
.tier-deep{color:var(--acc)}.tier-light{color:var(--sub)}.tier-archive{color:var(--raw);border-style:dashed}
.st-failed{color:var(--warn)}.st-waiting{color:var(--source)}.st-queued,.st-captured,.st-triaged,.st-reduced{color:var(--sub)}
.tabs{display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap}.tabs a{padding:5px 12px;border:1px solid var(--line);border-radius:999px;font-size:13px;color:var(--sub)}.tabs a.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px}.card h3{margin:0 0 6px;font-size:16px;color:var(--topic)}.card p{margin:0 0 8px;color:var(--sub);font-size:13.5px}.card span{font-size:12px}
.doc{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:28px;align-items:start}@media (max-width:900px){.doc{grid-template-columns:1fr}}
article{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:22px 26px}@media (max-width:600px){article{padding:16px}}
.dm{color:var(--sub);font-size:12.5px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.dm a{color:var(--acc)}
.tags{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}.tag{font-size:12px;color:var(--acc);background:var(--acc-soft);padding:1px 8px;border-radius:6px}
.md{font-size:15.5px;line-height:1.75}.md h1{font-size:24px;line-height:1.35;letter-spacing:-.02em;margin:14px 0 12px}.md h2{font-size:17px;margin:26px 0 8px;padding-top:12px;border-top:1px solid var(--line)}.md h3{font-size:15.5px}
.md img{max-width:100%;height:auto;border-radius:8px;border:1px solid var(--line)}.md blockquote{margin:12px 0;padding:4px 14px;border-left:3px solid var(--line);color:var(--sub)}
.md pre{background:var(--bg);padding:12px;border-radius:8px;overflow:auto;font-size:13px}.md code{font-size:.9em}.md table{border-collapse:collapse;display:block;overflow:auto}.md td,.md th{border:1px solid var(--line);padding:4px 8px}
.md hr{border:0;border-top:1px dashed var(--line);margin:18px 0}
.wl{color:var(--acc);background:var(--acc-soft);padding:0 3px;border-radius:4px}.wl.dead{color:var(--sub);background:none;border-bottom:1px dashed var(--sub)}
aside{position:sticky;top:72px;display:flex;flex-direction:column;gap:14px}@media (max-width:900px){aside{position:static}}
aside section{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px}aside h4{margin:0 0 8px;font-size:13px;color:var(--sub)}
.mini{list-style:none;margin:0;padding:0;font-size:13.5px}.mini li{padding:4px 0;border-bottom:1px solid var(--line)}.mini li:last-child{border:0}
#graph{height:260px;border-radius:8px;background:var(--bg)}#graph svg{width:100%;height:100%;display:block}
#graph text{font-size:10px;fill:var(--sub);pointer-events:none}#graph line{stroke:var(--line);stroke-width:1.2}#graph circle{cursor:pointer;stroke:var(--panel);stroke-width:1.5}
.inline{margin-top:18px}.pager{display:flex;gap:12px;justify-content:center;margin-top:16px}.pager a{color:var(--acc)}
.empty{text-align:center;padding:60px 16px}.foot{margin-top:26px;font-size:12.5px}
`;

/** 의존성 없는 작은 힘-배치 그래프 (1~2단계 이웃만) */
export const GRAPH_JS = `
(async()=>{const el=document.getElementById('graph');if(!el)return;
const g=await (await fetch(el.dataset.src)).json();if(g.nodes.length<2){el.innerHTML='<p class="muted" style="padding:10px;font-size:13px">연결된 노트가 아직 없습니다.</p>';return}
const css=getComputedStyle(document.documentElement);const col={topic:css.getPropertyValue('--topic'),claim:css.getPropertyValue('--claim'),source:css.getPropertyValue('--source'),raw:css.getPropertyValue('--raw')};
const W=el.clientWidth,H=el.clientHeight;const idx=new Map();g.nodes.forEach((n,i)=>{n.x=W/2+Math.cos(i)*80*Math.random();n.y=H/2+Math.sin(i)*80*Math.random();n.vx=0;n.vy=0;idx.set(n.id,n)});
const E=g.edges.map(e=>[idx.get(e.s),idx.get(e.t)]).filter(e=>e[0]&&e[1]);const deg=new Map();E.forEach(([a,b])=>{deg.set(a,(deg.get(a)||0)+1);deg.set(b,(deg.get(b)||0)+1)});
for(let it=0;it<300;it++){const k=1-it/300;for(const a of g.nodes)for(const b of g.nodes){if(a===b)continue;let dx=a.x-b.x,dy=a.y-b.y,d2=dx*dx+dy*dy+.01;const f=900/d2;a.vx+=dx*f*.05;a.vy+=dy*f*.05}
for(const[a,b]of E){const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)+.01,f=(d-70)*.02;a.vx+=dx/d*f;a.vy+=dy/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f}
for(const n of g.nodes){n.vx+=(W/2-n.x)*.004;n.vy+=(H/2-n.y)*.004;if(n.id===g.center){n.x=W/2;n.y=H/2;continue}n.x+=n.vx*k;n.y+=n.vy*k;n.vx*=.6;n.vy*=.6;n.x=Math.max(12,Math.min(W-12,n.x));n.y=Math.max(12,Math.min(H-12,n.y))}}
const ns='http://www.w3.org/2000/svg';const svg=document.createElementNS(ns,'svg');
for(const[a,b]of E){const l=document.createElementNS(ns,'line');l.setAttribute('x1',a.x);l.setAttribute('y1',a.y);l.setAttribute('x2',b.x);l.setAttribute('y2',b.y);svg.appendChild(l)}
for(const n of g.nodes){const c=document.createElementNS(ns,'circle');const r=n.id===g.center?9:4+Math.min(5,(deg.get(n)||0));c.setAttribute('cx',n.x);c.setAttribute('cy',n.y);c.setAttribute('r',r);c.setAttribute('fill',col[n.type]||'#888');
const t=document.createElementNS(ns,'title');t.textContent=n.title;c.appendChild(t);c.onclick=()=>location.href='/n/'+encodeURIComponent(n.name);svg.appendChild(c);
if(n.id===g.center||n.type==='topic'){const tx=document.createElementNS(ns,'text');tx.setAttribute('x',n.x+r+3);tx.setAttribute('y',n.y+3);tx.textContent=n.title.length>18?n.title.slice(0,18)+'…':n.title;svg.appendChild(tx)}}
el.appendChild(svg)})();
`;
