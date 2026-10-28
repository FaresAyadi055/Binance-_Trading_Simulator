'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const KEY='bsim.tx.v1', REST='https://api.binance.com/api/v3';
const CFG={feeRate:0.001, gasUnits:200000, gasPriceGwei:3}; // BNB-network gas, 0.1% spot fee
let txs=load(), sym='BTC', side='buy', klines=[], ws, estTimer, busy=false, kToken=0;
const px={}, open={}, vol={};

/* ---------- storage & ledger ---------- */
function load(){try{const v=JSON.parse(localStorage.getItem(KEY));return Array.isArray(v)?v:[]}catch{return[]}}
function save(){localStorage.setItem(KEY,JSON.stringify(txs))}
function uuid7(ts){const t=ts.toString(16).padStart(12,'0'),r=crypto.getRandomValues(new Uint8Array(10)),h=[...r].map(b=>b.toString(16).padStart(2,'0')).join('');
  return `${t.slice(0,8)}-${t.slice(8)}-7${h.slice(0,3)}-${((r[5]&3)|8).toString(16)}${h.slice(3,6)}-${h.slice(6,18)}`}
// All state is derived by replaying the ledger (average-cost accounting).
function derive(list){
  const s={usdt:0,pos:{},gains:0,loss:0,wins:0,sells:0,fees:0};
  for(const t of list){
    const a=+t.amount,u=+t.amount_in_USDT,f=+t.fees||0;
    if(t.action==='deposit')s.usdt+=u;
    else if(t.action==='withdraw')s.usdt-=u;
    else if(t.action==='buy'){s.usdt-=u+f;s.fees+=f;const p=s.pos[t.currency]??={qty:0,cost:0};p.qty+=a;p.cost+=u+f}
    else if(t.action==='sell'){const p=s.pos[t.currency];if(!p||p.qty<a-1e-9)continue;
      const avg=p.cost/p.qty,pnl=u-f-avg*a;s.usdt+=u-f;s.fees+=f;p.qty-=a;p.cost-=avg*a;
      if(p.qty<1e-9)p.qty=p.cost=0;s.sells++;if(pnl>0){s.gains+=pnl;s.wins++}else s.loss-=pnl}
  }
  return s;
}
const gasUSDT=()=>CFG.gasUnits*CFG.gasPriceGwei*1e-9*(px.BNB||0);

/* ---------- formatting ---------- */
const fmt=(n,d=2)=>(+n).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d});
const pf=p=>p>=100?fmt(p,2):p>=1?fmt(p,4):fmt(p,8);
const toast=m=>{const t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(toast.t);toast.t=setTimeout(()=>t.classList.remove('on'),2800)};
const card=(l,v,cls='',w='')=>`<div class="card ${w}"><small>${l}</small><b class="${cls}">${v}</b></div>`;

/* ---------- market data ---------- */
function ticks(arr){
  for(const t of arr){if(!t.s.endsWith('USDT'))continue;const b=t.s.slice(0,-4);px[b]=+t.c;open[b]=+t.o;vol[b]=+t.q}
  live();
}
function connect(){
  ws=new WebSocket('wss://stream.binance.com:9443/stream');
  ws.onopen=()=>{$('#ws').classList.add('ok');ws.send(JSON.stringify({method:'SUBSCRIBE',params:['!miniTicker@arr',`${sym.toLowerCase()}usdt@kline_1s`],id:1}))};
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.stream==='!miniTicker@arr')ticks(m.data);else if(m.data&&m.data.k)kline(m.data.k)};
  ws.onclose=()=>{$('#ws').classList.remove('ok');setTimeout(connect,2000)};
}
function kline(k){
  if(k.s!==sym+'USDT')return;const c={t:k.t,o:+k.o,h:+k.h,l:+k.l,c:+k.c},last=klines[klines.length-1];
  if(last&&last.t===c.t)klines[klines.length-1]=c;else{klines.push(c);if(klines.length>400)klines.shift()}
  px[sym]=c.c;requestAnimationFrame(draw);
}
async function loadKlines(){
  const tok=++kToken;klines=[];draw();
  try{const r=await(await fetch(`${REST}/klines?symbol=${sym}USDT&interval=1s&limit=200`)).json();
    if(tok===kToken)klines=r.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4]})).concat(klines.filter(k=>k.t>r[r.length-1][0]));draw()}catch{toast('Could not load candles')}
}
async function seedPrices(){
  try{const r=await(await fetch(`${REST}/ticker/price`)).json();for(const t of r)if(t.symbol.endsWith('USDT'))px[t.symbol.slice(0,-4)]??=+t.price;live()}catch{}
}
// Fill simulation: walk the real order book (depth 1000) => genuine slippage.
async function fill(sd,amount){
  const[d,{serverTime:ts}]=await Promise.all([fetch(`${REST}/depth?symbol=${sym}USDT&limit=1000`).then(r=>r.json()),fetch(`${REST}/time`).then(r=>r.json())]);
  const mid=(+d.bids[0][0]+ +d.asks[0][0])/2;let qty=0,quote=0,left=amount;
  if(sd==='buy'){for(const[p,q]of d.asks){const pr=+p,c=pr*+q;if(c>=left){qty+=left/pr;quote+=left;left=0;break}qty+=+q;quote+=c;left-=c}}
  else{for(const[p,q]of d.bids){const pr=+p,qy=+q;if(qy>=left){qty+=left;quote+=left*pr;left=0;break}qty+=qy;quote+=qy*pr;left-=qy}}
  if(left>1e-8)throw Error('Not enough order-book liquidity');
  const base=sd==='buy'?qty:amount,avg=quote/base;
  return{qty:base,quote,avg,mid,ts,slip:Math.abs(avg-mid)*base};
}

/* ---------- chart ---------- */
function draw(){
  const c=$('#chart'),x=c.getContext('2d'),dpr=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;
  c.width=w*dpr;c.height=h*dpr;x.scale(dpr,dpr);
  const n=Math.min(klines.length,Math.floor((w-60)/7)),v=klines.slice(-n);if(!n)return;
  let hi=Math.max(...v.map(k=>k.h)),lo=Math.min(...v.map(k=>k.l));const pad=(hi-lo)*.1||hi*.001;hi+=pad;lo-=pad;
  const W=w-60,bw=W/n,Y=p=>h-(p-lo)/(hi-lo)*h;
  v.forEach((k,i)=>{x.fillStyle=x.strokeStyle=k.c>=k.o?'#2ebd85':'#f6465d';const cx=i*bw+bw/2;
    x.beginPath();x.moveTo(cx,Y(k.h));x.lineTo(cx,Y(k.l));x.stroke();
    const t=Y(Math.max(k.o,k.c)),b=Y(Math.min(k.o,k.c));x.fillRect(i*bw+bw*.15,t,bw*.7,Math.max(1,b-t))});
  x.fillStyle='#8a94a3';x.font='11px system-ui';x.textAlign='left';
  [hi,(hi+lo)/2,lo].forEach((p,i)=>x.fillText(pf(p),W+4,[12,h/2,h-4][i]));
}

/* ---------- views ---------- */
function live(){
  const s=derive(txs);$('#bal').textContent=fmt(s.usdt);
  const p=px[sym];if(p){$('#price').textContent=pf(p);const ch=open[sym]?(p/open[sym]-1)*100:0;
    $('#chg').textContent=(ch>=0?'+':'')+fmt(ch)+'% 24h';$('#chg').className=ch>=0?'up':'dn'}
  if($('#analytics').classList.contains('on'))renderAnalytics(s);
  if($('#assets').classList.contains('on'))renderAssets(s);
}
function renderAnalytics(s=derive(txs)){
  let assets=0;const rows=Object.entries(s.pos).filter(([,p])=>p.qty>0);
  for(const[k,p]of rows)assets+=p.qty*(px[k]||0);
  const net=s.usdt+assets;
  $('#cards').innerHTML=card('Net worth (USDT)',fmt(net),'','wide')+card('Liquid assets (USDT)',fmt(s.usdt))+card('Total gains',fmt(s.gains),'up')+card('Total loss',fmt(s.loss),'dn')
    +card('Success rate',s.sells?fmt(s.wins/s.sells*100,1)+'% ('+s.wins+'/'+s.sells+')':'–')+card('Fees paid',fmt(s.fees,4));
  $('#hold').innerHTML=rows.length?rows.map(([k,p])=>`<div class="row"><span>${k}</span><span>${+p.qty.toFixed(8)} <small>≈ ${fmt(p.qty*(px[k]||0))} USDT</small></span></div>`).join(''):'<p class="est">No assets yet. Buy something on the Trade tab.</p>';
  renderMissed();
}

/* ---------- assets ---------- */
function renderAssets(s=derive(txs)){
  const rows=Object.entries(s.pos).filter(([,p])=>p.qty>1e-12)
    .map(([k,p])=>({k,qty:p.qty,cost:p.cost,price:px[k]||0})).sort((a,b)=>b.qty*b.price-a.qty*a.price);
  let hold=0;for(const r of rows)hold+=r.qty*r.price;
  const net=s.usdt+hold;
  const head=card('Net worth (USDT)',fmt(net),'','wide')+card('Crypto holdings',fmt(hold))+card('USDT cash',fmt(s.usdt));
  const list=rows.map(({k,qty,cost,price})=>{
    const val=qty*price,avg=cost/qty,pnl=val*(1-CFG.feeRate)-gasUSDT()-cost,pct=cost?pnl/cost*100:0,sh=net?val/net*100:0;
    return `<div class="ac" data-a="${k}" title="Trade ${k}">
      <div class="ah"><b>${k}</b><span>${+qty.toFixed(8)} ${k}</span></div>
      <div class="ag"><div><small>Avg cost</small>${pf(avg)}</div><div><small>Price</small>${pf(price)}</div>
        <div><small>Value</small>${fmt(val)}</div><div><small>Share</small>${fmt(sh,1)}%</div></div>
      <div class="ap"><small>Unrealized P&amp;L · net of exit fees</small><b class="${pnl>=0?'up':'dn'}">${pnl>=0?'+':''}${fmt(pnl)} <span class="dim">(${pnl>=0?'+':''}${fmt(pct,1)}%)</span></b></div></div>`}).join('');
  $('#ast').innerHTML=`<div class="cards">${head}</div>`+(rows.length?`<div class="alist">${list}</div>`:'<p class="est">No assets yet. Buy something on the Trade tab.</p>');
}

/* ---------- missed opportunities ---------- */
const IVS=[[1e3,'1s'],[60e3,'1m'],[300e3,'5m'],[900e3,'15m'],[3.6e6,'1h'],[14.4e6,'4h'],[86.4e6,'1d'],[604.8e6,'1w']],MC=new Map();
let msig=null;
const lastBuy=k=>{let t=0;for(const x of txs)if(x.action==='buy'&&x.currency===k&&x.timestamp>t)t=x.timestamp;return t};
const ivFor=ms=>{for(const[sp,iv]of IVS)if(ms<=sp*1000)return iv;return '1M'};
const netOf=(q,p)=>q*p*(1-CFG.feeRate)-gasUSDT();
// Best sellable price per candle (high) since the last buy => net USDT after fees & gas.
async function mseries(k){
  const from=lastBuy(k),key=`${k}|${from}`,hit=MC.get(key);if(hit)return hit;
  const d=await(await fetch(`${REST}/klines?symbol=${k}USDT&interval=${ivFor(Date.now()-from)}&startTime=${from}&limit=1000`)).json();
  if(!Array.isArray(d))throw Error('no candles');
  const s={t0:from,pts:d.map(c=>({t:c[0],p:+c[2]}))};
  if(s.pts.length)MC.set(key,s); // empty = brand-new buy; retry next render instead of caching
  return s;
}
function thin(a,max=160){if(a.length<=max)return a.slice();const o=[],st=a.length/max;for(let i=0;i<max;i++)o.push(a[Math.floor(i*st)]);return o}
const stamp=(t,span)=>{const o={month:'short',day:'numeric'};if(span<1728e5){o.hour='2-digit';o.minute='2-digit'}return new Date(t).toLocaleString(undefined,o)};
const MY=(v,lo,hi)=>96-5-((v-lo)/((hi-lo)||1))*86;
function buildMissed(k,qty,s){
  const el=$(`#missed [data-k="${k}"]`);if(!el)return;
  const span=Date.now()-s.t0,nowP=px[k]||(s.pts.length?s.pts[s.pts.length-1].p:0),pts=s.pts.concat({t:Date.now(),p:nowP});
  if(pts.length<2||!nowP){el.innerHTML=`<div class="mh"><b>${k}</b><span class="msub">${+qty.toFixed(8)} ${k}</span></div><p class="est">Bought moments ago — no candles yet. Hit Refresh in a minute.</p>`;return}
  const vals=pts.map(x=>netOf(qty,x.p));
  let pi=0;for(let i=1;i<vals.length;i++)if(vals[i]>vals[pi])pi=i;
  const peak=vals[pi],now=vals[vals.length-1],miss=Math.max(0,peak-now);
  const lo=Math.min(...vals),hi=Math.max(...vals);
  const W=300,H=96,P=5,t0=s.t0,t1=pts[pts.length-1].t;
  const X=t=>((t-t0)/((t1-t0)||1))*(W-2*P)+P,Y=v=>MY(v,lo,hi);
  const sm=thin(pts.map((p,i)=>({t:p.t,v:vals[i]})));
  const near=sm.findIndex(q=>q.t>=pts[pi].t);if(near>=0)sm[near]={t:pts[pi].t,v:peak};
  const d=sm.map((q,i)=>(i?'L':'M')+X(q.t).toFixed(1)+' '+Y(q.v).toFixed(1)).join(' ');
  el.dataset.qty=qty;el.dataset.peak=peak;el.dataset.lo=lo;el.dataset.hi=hi;
  el.innerHTML=`<div class="mh"><b>${k}</b><span class="msub">${+qty.toFixed(8)} ${k}</span></div>
    <svg class="mchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${k}: best net liquidation value since last buy">
      <path d="${d} L ${X(t1).toFixed(1)} ${H-P} L ${X(t0).toFixed(1)} ${H-P} Z" fill="var(--ac)" opacity=".08"/>
      <line data-now x1="${P}" x2="${W-P}" y1="${Y(now).toFixed(1)}" y2="${Y(now).toFixed(1)}" stroke="var(--mu)" stroke-dasharray="3 3"/>
      <path d="${d}" fill="none" stroke="var(--ac)" stroke-width="1.5" stroke-linejoin="round"/>
      <circle cx="${X(pts[pi].t).toFixed(1)}" cy="${Y(peak).toFixed(1)}" r="3" fill="var(--up)"/>
    </svg>
    <div class="mstats">
      <div class="miss"><small>Missed profit</small><b data-missv class="${miss>0.005?'up':'mu'}">${miss>0.005?'+':''}${fmt(miss)} USDT</b></div>
      <div><small>Net if sold now</small><b data-nowv>${fmt(now)}</b></div>
      <div><small>Peak price</small><b>${pf(pts[pi].p)}</b></div>
      <div><small>Peak on</small><b>${stamp(pts[pi].t,span)}</b></div>
    </div>`;
}
// Ticker ticks: refresh only the live numbers, never the DOM shell (keeps swipe position).
function updateMissed(){
  for(const el of $$('#missed [data-k]')){
    const d=el.dataset,p=px[d.k];if(!d.peak||!p)continue;
    const now=netOf(+d.qty,p),miss=Math.max(0,+d.peak-now),y=MY(now,+d.lo,+d.hi).toFixed(1);
    el.querySelector('[data-nowv]').textContent=fmt(now);
    const m=el.querySelector('[data-missv]');m.textContent=(miss>0.005?'+':'')+fmt(miss)+' USDT';m.className=miss>0.005?'up':'mu';
    const l=el.querySelector('[data-now]');l.setAttribute('y1',y);l.setAttribute('y2',y);
  }
}
async function renderMissed(force){
  const rows=Object.entries(derive(txs).pos).filter(([,p])=>p.qty>1e-12);
  const sig=rows.map(([k,p])=>`${k}:${lastBuy(k)}:${p.qty}`).join('|');
  if(!force&&sig===msig)return updateMissed();
  msig=sig;if(force)MC.clear();
  const box=$('#missed');if(!box)return;
  if(!rows.length){box.innerHTML='<p class="est">No open positions yet. Buy something and its best sell value will show up here.</p>';return}
  box.innerHTML=rows.map(([k,p])=>`<div class="mcard" data-k="${k}"><div class="mh"><b>${k}</b><span class="msub">${+p.qty.toFixed(8)} ${k}</span></div><p class="est">Loading history…</p></div>`).join('');
  await Promise.all(rows.map(async([k,p])=>{
    try{buildMissed(k,p.qty,await mseries(k))}
    catch{const el=$(`#missed [data-k="${k}"]`),lp=el&&el.querySelector('p');if(lp)lp.textContent='Could not load history from Binance.'}
  }));
}
function renderHistory(){
  $('#hist').innerHTML=txs.length?[...txs].reverse().map(t=>{const tr=t.action==='buy'||t.action==='sell';
    return `<div class="tx"><div><b class="${t.action}">${t.action.toUpperCase()}</b> ${t.currency} ${tr?+(+t.amount).toFixed(8):''}<br><small>${new Date(t.timestamp).toLocaleString()}</small></div>
    <div class="r">${fmt(t.amount_in_USDT)} USDT<br><small>fees ${fmt(t.fees,4)}</small></div>
    <small>${tr?'@ '+pf(t.price)+' · slippage '+fmt(t.slippage_usdt||0,4):''}</small><div class="r"><button data-rb="${t.timestamp}">Rollback here</button></div></div>`}).join('')
    :'<p class="est">No transactions yet.</p>';
}
function setSide(s){side=s;$$('[data-side]').forEach(b=>b.classList.toggle('on',b.dataset.side===s));
  $('#amtlbl').textContent=s==='buy'?'Amount (USDT)':`Amount (${sym})`;$('#go').textContent=`${s==='buy'?'Buy':'Sell'} ${sym}`;$('#amt').value='';$('#est').textContent='Enter an amount to see the fill price, slippage and fees.'}
function setSym(s){const old=sym;sym=s;$('#pick').textContent=s+'/USDT ▾';setSide(side);klines=[];loadKlines();
  if(ws&&ws.readyState===1){ws.send(JSON.stringify({method:'UNSUBSCRIBE',params:[`${old.toLowerCase()}usdt@kline_1s`],id:2}));ws.send(JSON.stringify({method:'SUBSCRIBE',params:[`${s.toLowerCase()}usdt@kline_1s`],id:3}))}live()}
function renderPicker(){
  const q=$('#q').value.trim().toUpperCase();
  const l=Object.keys(px).filter(k=>k.includes(q)).sort((a,b)=>(vol[b]||0)-(vol[a]||0)).slice(0,60);
  $('#list').innerHTML=l.map(k=>`<li data-s="${k}"><b>${k}</b><span>${pf(px[k])}</span></li>`).join('')||'<li>No match</li>';
}

/* ---------- trading ---------- */
async function estimate(){
  const v=+$('#amt').value;if(!(v>0))return;
  try{const f=await fill(side,v),fee=f.quote*CFG.feeRate+gasUSDT();
    $('#est').textContent=`Avg fill ${pf(f.avg)} (mid ${pf(f.mid)})\nSlippage ${fmt(f.slip,4)} USDT · Fee ${fmt(f.quote*CFG.feeRate,4)} + gas ${fmt(gasUSDT(),4)}\n${side==='buy'?'You get':'You receive'} ${side==='buy'?+f.qty.toFixed(8)+' '+sym:fmt(f.quote-fee)+' USDT'}`}
  catch(e){$('#est').textContent=e.message}
}
async function trade(){
  const v=+$('#amt').value;if(!(v>0))return toast('Enter an amount');if(busy)return;busy=true;$('#go').disabled=true;
  try{const s=derive(txs),f=await fill(side,v),fee=f.quote*CFG.feeRate+gasUSDT();
    if(side==='buy'&&f.quote+fee>s.usdt+1e-9)throw Error('Not enough USDT (fees included)');
    if(side==='sell'&&v>((s.pos[sym]||{}).qty||0)+1e-9)throw Error(`Not enough ${sym}`);
    txs.push({id:uuid7(f.ts),action:side,currency:sym,amount:f.qty,amount_in_USDT:f.quote,fees:fee,timestamp:f.ts,price:f.avg,slippage_usdt:f.slip});
    save();toast(`${side==='buy'?'Bought':'Sold'} ${+f.qty.toFixed(8)} ${sym}`);$('#amt').value='';live()}
  catch(e){toast(e.message)}finally{busy=false;$('#go').disabled=false}
}
async function credit(kind){
  const v=+prompt(kind==='deposit'?'USDT to add:':'USDT to remove:');if(!(v>0))return;
  if(kind==='withdraw'&&v>derive(txs).usdt)return toast('Not enough liquid USDT');
  try{const{serverTime:ts}=await(await fetch(`${REST}/time`)).json();
    txs.push({id:uuid7(ts),action:kind,currency:'USDT',amount:v,amount_in_USDT:v,fees:0,timestamp:ts});save();live();renderHistory()}
  catch{toast('Could not reach Binance time API')}
}

/* ---------- history tools ---------- */
function download(){const b=new Blob([JSON.stringify({version:1,exported_at:Date.now(),transactions:txs.map(t=>({transaction:t}))},null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=`binance-sim-${Date.now()}.json`;a.click();URL.revokeObjectURL(a.href)}
async function importFile(f){
  try{const j=JSON.parse(await f.text()),raw=Array.isArray(j)?j:j.transactions;
    const list=raw.map(x=>x.transaction||x).sort((a,b)=>a.timestamp-b.timestamp);
    const ok=list.every(t=>t.id&&['buy','sell','deposit','withdraw'].includes(t.action)&&isFinite(+t.amount)&&isFinite(+t.amount_in_USDT)&&isFinite(+t.fees)&&isFinite(+t.timestamp));
    if(!ok||derive(list).usdt<-1e-6)throw Error();
    if(!confirm(`Overwrite current history with ${list.length} imported transactions?`))return;
    txs=list;save();renderHistory();live();toast('History imported')}
  catch{toast('Invalid or inconsistent history file')}
}
function rollback(ts){
  const gone=txs.filter(t=>t.timestamp>ts).length;if(!gone)return toast('Already the latest transaction');
  if(confirm(`Delete ${gone} newer transaction(s)? This overwrites your history.`)){txs=txs.filter(t=>t.timestamp<=ts);save();renderHistory();live()}
}

/* ---------- wiring ---------- */
function go(p){
  $$('nav button').forEach(x=>x.classList.toggle('on',x.dataset.page===p));$$('.page').forEach(x=>x.classList.toggle('on',x.id===p));
  if(p==='history')renderHistory();if(p==='analytics')renderAnalytics();if(p==='assets')renderAssets();if(p==='trade')draw()}
$$('nav button').forEach(b=>b.onclick=()=>go(b.dataset.page));
$('#ast').onclick=e=>{const c=e.target.closest('[data-a]');if(c){setSym(c.dataset.a);go('trade')}};
$('#mrf').onclick=()=>renderMissed(true);
$$('[data-side]').forEach(b=>b.onclick=()=>setSide(b.dataset.side));
$$('[data-p]').forEach(b=>b.onclick=()=>{const p=+b.dataset.p/100,s=derive(txs);
  if(side==='buy')$('#amt').value=Math.max(0,((s.usdt-gasUSDT())/(1+CFG.feeRate))*p).toFixed(2);
  else{const q=(s.pos[sym]||{}).qty||0;$('#amt').value=p===1?q:Math.floor(q*p*1e8)/1e8}estimate()});
$('#amt').oninput=()=>{clearTimeout(estTimer);estTimer=setTimeout(estimate,350)};
$('#go').onclick=trade;$('#add').onclick=()=>credit('deposit');$('#rem').onclick=()=>credit('withdraw');
$('#pick').onclick=()=>{$('#q').value='';renderPicker();$('#picker').showModal()};$('#close').onclick=()=>$('#picker').close();
$('#q').oninput=renderPicker;$('#list').onclick=e=>{const li=e.target.closest('li[data-s]');if(li){setSym(li.dataset.s);$('#picker').close()}};
$('#dl').onclick=download;$('#imp').onclick=()=>$('#file').click();$('#file').onchange=e=>{if(e.target.files[0])importFile(e.target.files[0]);e.target.value=''};
$('#hist').onclick=e=>{const b=e.target.closest('[data-rb]');if(b)rollback(+b.dataset.rb)};
addEventListener('resize',draw);
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
seedPrices();loadKlines();connect();live();
