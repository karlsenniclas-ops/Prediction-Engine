import {align, chart} from './charts.js';
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = v => typeof v === 'number' && Number.isFinite(v);
const cents = v => {if(!number(v))return '—';const c=(v*100).toFixed(2);return (c==='-0.00'?'0.00':c)+'¢';};
const money = v => number(v) ? new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(v) : '—';
const pct = v => number(v) ? (v*100).toFixed(2)+'%' : '—';
const tone = v => number(v) ? v>0?'positive':v<0?'negative':'' : '';
const COLORS = {kalshi:'#43d9b0', polymarket:'#72aaff'};
let selected=null, detail=null, histories=null, mode='history', route=null, suggestions=[], active=-1, searchSeq=0, loadSeq=0, timer, resizeTimer;

const mi=s=>`<mi>${s}</mi>`, mo=s=>`<mo${"()|".includes(s)?" stretchy=\"false\"":""}>${s}</mo>`, mn=s=>`<mn>${s}</mn>`, mtext=s=>`<mtext>${s}</mtext>`;
const sub=(a,b)=>`<msub>${a}${b}</msub>`, frac=(a,b)=>`<mfrac><mrow>${a}</mrow><mrow>${b}</mrow></mfrac>`, bar=a=>`<mover accent="true">${a}<mo>¯</mo></mover>`;
const math=(...a)=>`<div class="eq"><math>${a.join('')}</math></div>`;
const P=s=>sub(bar(mi('p')),mi(s)), F=s=>sub(mi('f'),mi(s)), I=s=>sub(mi(s),mi('i'));
const SUM='<munder><mo>∑</mo><mi>i</mi></munder>', SEP='<mspace width="1.5em"></mspace>';
const d=(v,f,k=5)=>number(v)?`<mrow${f?' class="fetched"':''}>${v<0&&Math.abs(v).toFixed(k)!=(0).toFixed(k)?mo('−'):''}${mn(Math.abs(v).toFixed(k))}</mrow>`:mi('?'), D=v=>d(v,true);
const count=(v,f)=>`<mn${f?' class="fetched"':''}>${Number(v.toFixed(2)).toLocaleString('en-US')}</mn>`;
const feeOf=(r,p)=>number(r)?r*p*(1-p):0, latest=points=>[...points].reverse().find(p=>number(p[1])&&number(p[2]));
function singlePoints(v){const data=histories?.single?.[v];return v==='kalshi'?data||[]:align(data?.yes,(data?.no||[]).map(([t,p])=>[t,1-p]));}
const legsOf=key=>key==='kalshi_yes'?['kalshi','polymarket']:['polymarket','kalshi'];
function crossPoints(key){
  const k=histories?.single?.kalshi||[], p=histories?.single?.polymarket||{}, poly=side=>p[histories.flip?(side==='yes'?'no':'yes'):side];
  return key==='kalshi_yes'?align(k.map(([t,a])=>[t,a]),poly('no'),true):align(poly('yes'),k.map(([t,,b])=>[t,b]));
}
const A=(s,v)=>v?`<msubsup><mi>a</mi><mi>${s}</mi><mi>${v}</mi></msubsup>`:sub(mi('a'),mi(s)), lt=mo('&lt;');
const FORMULAS=[
  ['Single market arbitrage',math(A('Y'),mo('+'),A('N'),lt,mn(1)),'Buy Yes and No of the same market at the ask (Cheng et al.; Saguillo et al. call it long market rebalancing). The profit per pair before fees is 1 − a_Y − a_N.'],
  ['Cross-market arbitrage',math(A('Y','K'),mo('+'),A('N','P'),lt,mn(1),SEP,mtext('or'),SEP,A('Y','P'),mo('+'),A('N','K'),lt,mn(1)),'The same pair across Kalshi (K) and Polymarket (P). It only pays $1 if both venues settle the bet the same way.'],
  ['Executable size',math(mi('n'),mo('='),mi('min'),mo('('),mi('N'),mo(','),sub(mi('Q'),mi('Y')),mo(','),sub(mi('Q'),mi('N')),mo(')')),'N is the order, 1 or 1,000 contracts; Q is the depth on each ask book. The thinner leg is the bottleneck (Cheng et al.).'],
  ['Acquisition cost and fill price',math(mi('C'),mo('('),mi('n'),mo(')'),mo('='),SUM,I('p'),I('q'),SEP,bar(mi('p')),mo('='),frac(mi('C')+mo('(')+mi('n')+mo(')'),mi('n'))),'Walk the ask book from the best price until n contracts are filled (Gebele et al.). One contract fills at the best ask.'],
  ['Fee per leg',math(mi('f'),mo('='),mi('r'),SUM,I('q'),I('p'),mo('('),mn(1),mo('−'),I('p'),mo(')')),'r is the venue rate: 0.07 times the series multiplier on Kalshi, the market fee rate on Polymarket. Kalshi rounds each order up to a whole cent.'],
  ['Cost per pair',math(mi('K'),mo('='),P('Y'),mo('+'),P('N'),mo('+'),frac(F('Y')+mo('+')+F('N'),mi('n'))),''],
  ['Net per pair',math(mi('π'),mo('='),mn(1),mo('−'),mi('K')),'One Yes and one No pay $1 together, whichever way the market settles.'],
  ['Net total',math(mi('Π'),mo('='),mi('n'),mo('−'),mi('n'),mi('K'),mo('='),mi('n'),mo('·'),mi('π')),'Settlement profit, written Π(q) = q − C(q) in Gebele et al.'],
  ['Return',math(mi('ROI'),mo('='),frac(mi('π'),mi('K'))),'Multiply by 10,000 for basis points, the unit Cheng et al. report.'],
  ['Slippage',math(mi('s'),mo('='),P('Y'),mo('+'),P('N'),mo('−'),A('Y'),mo('−'),A('N')),'a is the best ask. Slippage is already inside p̄ and is not subtracted again.'],
  ['Single market history',math(mi('g'),mo('='),mn(1),mo('−'),A('Y'),mo('−'),A('N'),mo('−'),mi('r'),A('Y'),mo('('),mn(1),mo('−'),A('Y'),mo(')'),mo('−'),mi('r'),A('N'),mo('('),mn(1),mo('−'),A('N'),mo(')')),'Condition 1 through time, net of fees per contract without Kalshi\'s cent rounding. Green when g > 0. Saguillo et al. only count g of at least $0.05.'],
  ['Cross-market history',math(mi('g'),mo('='),mn(1),mo('−'),A('Y','K'),mo('−'),A('N','P'),mo('−'),sub(mi('r'),mi('K')),A('Y','K'),mo('('),mn(1),mo('−'),A('Y','K'),mo(')'),mo('−'),sub(mi('r'),mi('P')),A('N','P'),mo('('),mn(1),mo('−'),A('N','P'),mo(')')),'Condition 2 through time for the chosen route, with the venues swapped for the other route. Green when g > 0.'],
];
$('formulas').innerHTML=FORMULAS.map(([t,m,n])=>`<li><strong>${t}</strong>${m}${n?`<small>${n}</small>`:''}</li>`).join('');

async function api(path, params={}) {
  const response=await fetch(path+'?'+new URLSearchParams(params));
  const data=await response.json();
  if(!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function hideSuggestions(){$('suggestions').hidden=true;$('search').setAttribute('aria-expanded','false');$('search').removeAttribute('aria-activedescendant');}
function showSuggestions(){
  $('suggestions').innerHTML=suggestions.length?suggestions.map((m,i)=>`<div id="suggestion-${i}" role="option" aria-selected="${i===active}" class="suggestion" data-index="${i}"><span class="venue-tag ${m.venue}">${m.venue}</span><div><strong>${esc(m.title)}</strong><small>${[esc(m.outcome),m.closed?'Closed':m.paired?'Pair available':'Single market'].filter(Boolean).join(' · ')}</small></div></div>`).join(''):'<div class="suggestion">No matching bets. Try another phrase or refresh the catalogue.</div>';
  $('suggestions').hidden=false;$('search').setAttribute('aria-expanded','true');
  if(active>=0){$('search').setAttribute('aria-activedescendant',`suggestion-${active}`);$(`suggestion-${active}`).scrollIntoView({block:'nearest'});}
}
async function search(){
  const seq=++searchSeq;
  try{const found=await api('/api/search',{q:$('search').value});if(seq!==searchSeq)return;suggestions=found;active=-1;showSuggestions();}
  catch(e){$('request-status').textContent=e.message;}
}
function searching(){$('suggestions').innerHTML='<div class="suggestion muted"><span class="spinner" aria-hidden="true"></span>Searching…</div>';$('suggestions').hidden=false;$('search').setAttribute('aria-expanded','true');}
$('search').addEventListener('input',()=>{searchSeq++;searching();clearTimeout(timer);timer=setTimeout(search,120);});
$('search').addEventListener('focus',()=>{searching();search();});
$('search').addEventListener('keydown',e=>{
  if(e.key==='Escape'){hideSuggestions();return;}
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(!suggestions.length)return;active=(active+(e.key==='ArrowDown'?1:-1)+suggestions.length)%suggestions.length;showSuggestions();}
  if(e.key==='Enter'&&suggestions.length){e.preventDefault();choose(suggestions[Math.max(0,active)]);}
});
$('suggestions').addEventListener('click',e=>{const option=e.target.closest('[data-index]');if(option)choose(suggestions[Number(option.dataset.index)]);});
document.addEventListener('click',e=>{if(!e.target.closest('.search-wrap'))hideSuggestions();});
document.addEventListener('keydown',e=>{if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)){e.preventDefault();$('search').focus();}});
function choose(m){
  selected={venue:m.venue,id:m.id};$('search').value=m.title;hideSuggestions();searchSeq++;
  const url=new URL(location.href);url.search=new URLSearchParams(selected);history.replaceState(null,'',url);
  histories=null;detail=null;route=null;ticks={};$('empty').hidden=true;$('workspace').hidden=false;$('reset').hidden=false;
  $('cards').innerHTML='<div class="market muted">Loading Kalshi…</div><div class="market polymarket-card muted">Loading Polymarket…</div>';
  clearRows();load(true);
}
function reset(){
  selected=null;detail=null;histories=null;route=null;loadSeq++;searchSeq++;
  $('search').value='';hideSuggestions();history.replaceState(null,'',location.pathname);
  $('workspace').hidden=true;$('empty').hidden=false;$('reset').hidden=true;$('refresh').disabled=false;$('request-status').textContent='';
  starter();
}
$('reset').onclick=reset;
async function load(withHistory=false){
  if(!selected)return;
  const seq=++loadSeq;$('request-status').textContent='Fetching order books…';$('refresh').disabled=true;
  if(withHistory){
    $('chart-note').textContent='Loading price history…';
    api('/api/history',selected).then(data=>{if(seq===loadSeq){histories=data;draw();if(detail)steps();}}).catch(e=>{if(seq===loadSeq){histories={};draw();$('chart-note').textContent=e.message;}});
  }
  try{
    const data=await api('/api/detail',selected);if(seq!==loadSeq)return;
    detail=data;render();$('request-status').textContent='Books received '+new Date(data.time*1000).toLocaleTimeString();
  }catch(e){if(seq===loadSeq){$('request-status').textContent=e.message;detail=null;$('cards').innerHTML='<div class="market">Unable to load books. Use Refresh books to retry.</div>';clearRows();draw();}}
  finally{if(seq===loadSeq)$('refresh').disabled=false;}
}
function card(m,v){
  if(!m)return `<article class="market ${v}-card"><div class="card-head"><span class="venue-tag ${v}">${v}</span><span class="badge">Unpaired</span></div><h2>No matched counterpart</h2><p class="description">This bet has no matched market on the other venue.</p></article>`;
  const q=m.quotes, name=v==='kalshi'?'Kalshi':'Polymarket';
  const state=m.error?'Cached quotes · '+m.error:!m.active?'Market inactive':'Book snapshot';
  return `<article class="market ${v}-card"><div class="card-head"><span class="venue-tag ${v}">${name}</span><span class="badge ${m.error?'warning':''}">${esc(state)}</span></div><h2>${esc(m.title)}</h2><div class="outcome">${esc(m.outcome||m.event)}</div><p class="description clamped" id="description-${v}">${esc(m.rules||'No settlement description supplied.')}</p><button class="read-more" data-description="${v}" aria-expanded="false" aria-controls="description-${v}">Read more…</button><div class="quotes">${[['yes_bid',m.sides[0]+' bid'],['yes_ask',m.sides[0]+' ask'],['no_bid',m.sides[1]+' bid'],['no_ask',m.sides[1]+' ask']].map(([key,label])=>`<div><span>${esc(label)}</span><strong>${cents(q[key])}</strong></div>`).join('')}</div><div class="card-meta"><span>Closes ${new Date(m.close).toLocaleDateString()}</span><span>Fee rate ${number(m.rate)?(m.rate*100).toFixed(1)+'%':'unknown'}</span><span>Depth ${m.book.yes.reduce((n,l)=>n+l[1],0).toLocaleString(undefined,{maximumFractionDigits:0})} / ${m.book.no.reduce((n,l)=>n+l[1],0).toLocaleString(undefined,{maximumFractionDigits:0})}</span></div></article>`;
}
$('cards').addEventListener('click',e=>{const b=e.target.closest('[data-description]');if(!b)return;const p=$('description-'+b.dataset.description);const collapsed=p.classList.toggle('clamped');b.textContent=collapsed?'Read more…':'Show less';b.setAttribute('aria-expanded',!collapsed);});
const HEAD='<tr class="group"><th></th><th colspan="6">One contract</th><th colspan="3">1,000 contracts</th></tr><tr><th>Route</th><th>Yes ask</th><th>No ask</th><th>Fees</th><th>Cost</th><th>Net</th><th>ROI</th><th>Net total</th><th>ROI</th><th>Assessment</th></tr>';
document.querySelectorAll('.worksheet thead').forEach(t=>t.innerHTML=HEAD);
const single=r=>!r.key.includes('_');
function clearRows(){$('rows-single').replaceChildren();$('rows-cross').replaceChildren();$('steps').replaceChildren();}
function rows(){
  const html=r=>{
    const b=r.bulk, fees=number(r.fee_yes)&&number(r.fee_no)?r.fee_yes+r.fee_no:null;
    return `<tr class="${r.key===route?'selected':''}"><td><button class="route" data-key="${r.key}" aria-pressed="${r.key===route}">${esc(r.label)}</button></td><td>${cents(r.yes)}</td><td>${cents(r.no)}</td><td>${cents(fees)}</td><td>${cents(r.n?r.cost:null)}</td><td class="${tone(r.edge)}">${cents(r.edge)}</td><td>${pct(r.roi)}</td><td class="${tone(b.profit)}">${money(b.profit)}${b.partial&&b.n?`<small>${b.n.toLocaleString()} filled</small>`:''}</td><td class="${tone(b.roi)}">${pct(b.roi)}</td><td>${esc(r.status)}</td></tr>`;
  };
  const cross=detail.rows.filter(r=>!single(r));
  $('rows-single').innerHTML=detail.rows.filter(single).map(html).join('');
  $('rows-cross').innerHTML=cross.length?cross.map(html).join(''):'<tr><td colspan="10" class="muted">No matched market on the other venue, so there is no cross-market route.</td></tr>';
  steps();
}
for(const id of ['rows-single','rows-cross'])$(id).addEventListener('click',e=>{const b=e.target.closest('[data-key]');if(!b)return;route=b.dataset.key;rows();if(!single({key:route})){$('direction').value=route;draw();}});
function fee(side,rate,kalshi,p,f){
  if(!number(rate))return math(F(side),mo('='),mi('?'));
  const base=[`<mn class="fetched">${rate.toFixed(3)}</mn>`,mo('×'),D(p),mo('×'),mo('('),mn(1),mo('−'),D(p),mo(')')].join('');
  return kalshi?math(F(side),mo('='),frac(mo('⌈')+mn(100)+mo('×')+base+mo('⌉'),mn(100)),mo('='),d(f)):math(F(side),mo('='),base,mo('='),d(f));
}
function steps(){
  const r=detail.rows.find(r=>r.key===route);if(!r)return;
  const b=r.bulk, N=detail.costs.n, one=single(r), n=b.n;
  $('steps-title').textContent='Worked example · '+r.label;
  const li=(i,t,m,note='')=>`<li value="${i}"><strong>${t}</strong>${m}${note?`<small>${note}</small>`:''}</li>`;
  const cmp=v=>v<1?lt:mo('≥'), sum=r.yes+r.no, [vy,vn]=r.key==='kalshi_yes'?['K','P']:['P','K'];
  const size=math(mi('n'),mo('='),mi('min'),mo('('),mn(1),mo(','),count(r.depth[0],true),mo(','),count(r.depth[1],true),mo(')'),mo('='),count(r.n))+
    math(mi('n'),mo('='),mi('min'),mo('('),count(N),mo(','),count(r.depth[0],true),mo(','),count(r.depth[1],true),mo(')'),mo('='),count(n));
  if(!r.n){$('steps').innerHTML=li(3,'Executable size',size,'One of the books has no asks, so nothing can be bought and the other steps have no numbers.');return;}
  const out=[
    one?li(1,'Single market arbitrage',math(A('Y'),mo('+'),A('N'),mo('='),D(r.yes),mo('+'),D(r.no),mo('='),d(sum),cmp(sum),mn(1)),sum<1?'The best asks leave room for a profit before fees.':'The best asks already cost $1 or more, so there is no arbitrage.')
       :li(1,'Single market arbitrage','','Used by the single market routes. This route is cross-market, see 2.'),
    one?li(2,'Cross-market arbitrage','','Used by the cross-market routes. This route stays on one venue, see 1.')
       :li(2,'Cross-market arbitrage',math(A('Y',vy),mo('+'),A('N',vn),mo('='),D(r.yes),mo('+'),D(r.no),mo('='),d(sum),cmp(sum),mn(1)),sum<1?'The best asks leave room for a profit before fees.':'The best asks already cost $1 or more, so there is no arbitrage.'),
    li(3,'Executable size',size,`Depth on the Yes and No ask books.${b.partial?` Only ${n.toLocaleString()} of ${N.toLocaleString()} contracts are available.`:''}`),
    li(4,'Acquisition cost and fill price',math(P('Y'),mo('='),D(r.yes),SEP,P('N'),mo('='),D(r.no))+
      (n?math(sub(mi('C'),mi('Y')),mo('('),mi('n'),mo(')'),mo('='),d(b.yes*n,false,2),SEP,P('Y'),mo('='),frac(d(b.yes*n,false,2),count(n)),mo('='),d(b.yes))+
         math(sub(mi('C'),mi('N')),mo('('),mi('n'),mo(')'),mo('='),d(b.no*n,false,2),SEP,P('N'),mo('='),frac(d(b.no*n,false,2),count(n)),mo('='),d(b.no)):''),
      'One contract fills at the best ask. At n contracts the fetched book levels are walked one by one.'),
    li(5,'Fee per leg',fee('Y',r.rates[0],r.cents[0],r.yes,r.fee_yes)+fee('N',r.rates[1],r.cents[1],r.no,r.fee_no)+
      (n?math(frac(F('Y')+mo('+')+F('N'),mi('n')),mo('='),d(b.fee_yes+b.fee_no)):''),r.cents.includes(true)?'Kalshi rounds each order up to a whole cent, which weighs heavily on a single contract.':''),
  ];
  if(!number(r.edge)){
    for(const [i,t] of [[6,'Cost per pair'],[7,'Net per pair'],[8,'Net total'],[9,'Return'],[10,'Slippage']])out.push(li(i,t,'','The fee rate for this market is unknown, so this is not computed.'));
  }else{
    const k=b.yes+b.no+b.fee_yes+b.fee_no, bulk=n&&number(b.edge);
    out.push(
      li(6,'Cost per pair',math(mi('K'),mo('='),D(r.yes),mo('+'),D(r.no),mo('+'),d(r.fee_yes),mo('+'),d(r.fee_no),mo('='),d(r.cost))+
        (bulk?math(mi('K'),mo('='),d(b.yes),mo('+'),d(b.no),mo('+'),d(b.fee_yes+b.fee_no),mo('='),d(k)):'')),
      li(7,'Net per pair',math(mi('π'),mo('='),mn(1),mo('−'),d(r.cost),mo('='),d(r.edge))+(bulk?math(mi('π'),mo('='),mn(1),mo('−'),d(k),mo('='),d(b.edge)):''),
        `${cents(r.edge)} on one contract${bulk?`, ${cents(b.edge)} per pair at ${n.toLocaleString()}`:''}.`),
      li(8,'Net total',math(mi('Π'),mo('='),mn(1),mo('−'),mn(1),mo('×'),d(r.cost),mo('='),d(r.edge))+
        (bulk?math(mi('Π'),mo('='),count(n),mo('−'),count(n),mo('×'),d(k),mo('='),d(b.profit,false,2)):''),bulk?`${money(b.profit)} for ${n.toLocaleString()} contracts.`:''),
      li(9,'Return',math(mi('ROI'),mo('='),frac(d(r.edge),d(r.cost)),mo('='),d(r.roi*100,false,2),mo('%'),mo('='),d(r.roi*1e4,false,0),mtext('&nbsp;bps'))+
        (bulk?math(mi('ROI'),mo('='),frac(d(b.edge),d(k)),mo('='),d(b.roi*100,false,2),mo('%')):'')),
      li(10,'Slippage',bulk?math(mi('s'),mo('='),d(b.yes),mo('+'),d(b.no),mo('−'),D(r.yes),mo('−'),D(r.no),mo('='),d(b.slippage)):'','What walking the book adds over the best asks at '+(n||N).toLocaleString()+' contracts.'),
    );
  }
  const when=t=>new Date(t).toLocaleString();
  if(one){
    const p=histories&&latest(singlePoints(r.key)), rate=r.rates[0];
    out.push(!histories?li(11,'Single market history','','Loading history…'):!p?li(11,'Single market history','','No history for this market.'):
      li(11,'Single market history',math(mi('g'),mo('='),mn(1),mo('−'),D(p[1]),mo('−'),D(1-p[2]),mo('−'),d(feeOf(rate,p[1])),mo('−'),d(feeOf(rate,1-p[2])),mo('='),d(p[2]-p[1]-feeOf(rate,p[1])-feeOf(rate,1-p[2]))),
        `Latest point on the chart, ${when(p[0])}. The two fees are r·a(1 − a) for each leg.`));
    out.push(li(12,'Cross-market history','','Used by the cross-market chart. This route stays on one venue, see 11.'));
  }else{
    const p=histories&&latest(crossPoints(r.key)), [r1,r2]=r.rates, f1=p&&feeOf(r1,p[1]), f2=p&&feeOf(r2,1-p[2]);
    out.push(li(11,'Single market history','','Used by the single market charts. This route is cross-market, see 12.'));
    out.push(!histories?li(12,'Cross-market history','','Loading history…'):!p?li(12,'Cross-market history','','No overlapping history on both venues.'):
      li(12,'Cross-market history',math(mi('g'),mo('='),mn(1),mo('−'),D(p[1]),mo('−'),D(1-p[2]),mo('−'),d(f1),mo('−'),d(f2),mo('='),d(p[2]-p[1]-f1-f2)),
        `Latest point on the cross-market chart for this route, ${when(p[0])}.`));
  }
  $('steps').innerHTML=out.join('');
}
function render(redraw=true){
  const open=[...document.querySelectorAll('.description:not(.clamped)')].map(p=>p.id);
  $('cards').innerHTML=card(detail.markets.kalshi,'kalshi')+card(detail.markets.polymarket,'polymarket');
  if($('search').value==='Selected market')$('search').value=detail.markets[selected.venue].title;
  for(const v of ['kalshi','polymarket']){const p=$('description-'+v),b=document.querySelector(`[data-description="${v}"]`);if(p&&b)b.hidden=p.scrollHeight<=p.clientHeight+1;}
  for(const id of open){const p=$(id),b=p&&document.querySelector(`[data-description="${id.slice(12)}"]`);if(b){p.classList.remove('clamped');b.textContent='Show less';b.setAttribute('aria-expanded',true);}}
  if(!detail.rows.some(r=>r.key===route))route=[...detail.rows].sort((a,b)=>(number(b.edge)?b.edge:-9)-(number(a.edge)?a.edge:-9))[0].key;
  rows();
  const cross=detail.rows.filter(r=>r.key.includes('_')), before=$('direction').value;
  $('direction').innerHTML=cross.map(r=>`<option value="${r.key}">${esc(r.label)}</option>`).join('');
  const want=cross.some(r=>r.key===route)?route:before;$('direction').value=cross.some(r=>r.key===want)?want:cross[0]?.key||'';
  const pair=detail.pair, m=pair?.match;
  $('match-state').textContent=pair?'Candidate · not settlement-verified':'No matched pair';
  $('evidence').innerHTML=`<div class="evidence-list">${pair?`<span>Title similarity <strong>${pair.cosine.toFixed(3)}</strong></span><span>Correlation <strong>${number(m?.corr)?m.corr.toFixed(3):'—'}</strong></span><span>Overlap <strong>${m?.points||0}</strong></span><span>Mean gap <strong>${cents(m?.gap)}</strong></span><span>Orientation <strong>${detail.flip?'Polymarket outcomes inverted':'Same direction'}</strong></span><span>Shared words <strong>${esc(pair.shared.join(', '))}</strong></span>`:'No counterpart passed the existing price-path filter.'}</div>`;
  $('caveats').innerHTML=detail.caveats.length?`<table><thead><tr><th>Check</th><th>Kalshi</th><th>Polymarket</th></tr></thead><tbody>${detail.caveats.map(r=>`<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('')}</tbody></table>`:'<p>Read the platform’s settlement rules above.</p>';
  if(redraw)draw();else live();
}
function draw(){
  const rate=v=>detail?.markets[v]?.rate, cost=feeOf, now=Date.now();
  for(const v of ['kalshi','polymarket']){
    const m=detail?.markets[v], sides=m?.sides||['Yes','No'], points=singlePoints(v);
    const labels=[sides[0]+' ask',`$1 − ${sides[1]} ask`];
    $('legend-'+v).innerHTML=labels.map((l,i)=>`<span class="${i?'ceiling':v}"><i></i>${esc(l)}</span>`).join('');
    $('note-'+v).textContent=!histories?'':(v==='kalshi'?'Hourly or daily candle closes. ':'Volume-weighted price takers paid each hour, latest 11,000 trades only. ')+'Green: Yes ask + No ask + fees below $1. Red: above.';
    $('readout-'+v).textContent='';
    chart($('chart-'+v),points,{history:true,labels:['Yes ask','$1 − No ask'],colors:[COLORS[v],'#d7dee7'],domain:histories?.span?.[v]&&[histories.span[v][0],now],
      edge:p=>p[2]-p[1]-cost(rate(v),p[1])-cost(rate(v),1-p[2]),edgeLabel:'Net after fees',
      empty:!histories?'Loading history…':detail&&!m?'No matched market on this venue.':null,onRead:t=>$('readout-'+v).textContent=t});
  }
  $('history-tab').setAttribute('aria-pressed',mode==='history');$('depth-tab').setAttribute('aria-pressed',mode==='depth');
  $('direction').hidden=!$('direction').options.length;$('range').hidden=mode!=='history';$('chart-readout').textContent='';
  const rk=rate('kalshi'), rp=rate('polymarket');
  let points=[],labels=[],options;
  if(mode==='history'){
    const key=$('direction').value, [first,second]=(detail?.rows.find(r=>r.key===key)?.label||' + ').split(' + '), legs=legsOf(key);
    labels=key?[first+' ask','$1 − '+second+' ask']:[];
    points=histories&&key?crossPoints(key):[];
    const range=$('range').value;if(range!=='all')points=points.filter(p=>p[0]>=now-Number(range)*86400000);
    $('chart-note').textContent=histories?`Green: ${first} ask + ${second} ask + fees below $1. Red: above${number(rk)&&number(rp)?'':' (an unknown fee rate counts as zero)'}. Kalshi candles against the hourly price Polymarket takers paid.`:'Loading history…';
    const opens=Object.values(histories?.span||{}).map(s=>s[0]);
    options={history:true,labels:[first,'$1 − '+second],domain:range==='all'&&opens.length?[Math.min(...opens),now]:null,edge:p=>p[2]-p[1]-cost(rate(legs[0]),p[1])-cost(rate(legs[1]),1-p[2]),edgeLabel:'Net after fees',
      empty:detail&&!key?'No matched market on the other venue.':null};
  }else{
    const row=detail?.rows.find(r=>r.key===$('direction').value);labels=row?.labels||[];points=detail?.curves[row?.key]||[];
    $('chart-note').textContent=row?'Contracts on a log scale · Green: positive net edge · Red: negative net edge · '+row.status:'';
    options={labels:['YES cost','NO ceiling'],empty:detail&&!row?'No matched market on the other venue, so there is no cross-market route.':null};
  }
  const legs=legsOf($('direction').value);
  $('legend').innerHTML=labels.map((label,i)=>`<span class="${legs[i]}"><i></i>${esc(label)}</span>`).join('');
  chart($('chart'),points,{...options,colors:legs.map(v=>COLORS[v]),onRead:text=>$('chart-readout').textContent=text});
  live();
}
let ticks={};
function live(){
  for(const [id,key] of [['kalshi','kalshi'],['polymarket','polymarket'],['cross',$('direction').value]]){
    const r=detail?.rows.find(r=>r.key===key), box=$('live-'+id);
    if(!r||!number(r.yes)||!number(r.no)){box.replaceChildren();continue;}
    const value=r.yes+r.no, tag=key+':'+selected.id, t=ticks[tag];
    if(t&&Math.abs(value-t.value)>1e-9)ticks[tag]={value,change:value-t.value};
    else if(!t||t.change===null&&histories&&!t.tried){
      const p=histories&&latest(id==='cross'?crossPoints(key):singlePoints(key));
      ticks[tag]={value,change:p?value-(p[1]+1-p[2]):null,tried:!!histories};
    }
    const c=number(ticks[tag].change)?Math.round(ticks[tag].change*1e4)/1e4:null, side=!c?'':c<0?'positive':'negative';
    box.innerHTML=`<span>Live ${esc(r.label.replace(' · both outcomes',' Yes + No'))}</span><strong class="${side}">${cents(value)}</strong><small class="${side}">${number(c)?(c<0?'▼ ':c>0?'▲ ':'')+cents(Math.abs(c)):''}</small>`;
    box.title='Yes ask + No ask for one pair from the latest books. Green when it fell since the last change, red when it rose.';
  }
}
async function poll(){
  if(!selected||!detail||document.hidden||$('refresh').disabled)return;
  const seq=loadSeq;
  try{const data=await api('/api/detail',selected);if(seq!==loadSeq)return;detail=data;render(false);if(mode==='depth')draw();$('request-status').textContent='Books received '+new Date(data.time*1000).toLocaleTimeString();}
  catch(e){if(seq===loadSeq)$('request-status').textContent='Refresh failed · books from '+new Date(detail.time*1000).toLocaleTimeString();}
}
setInterval(poll,60000);
$('history-tab').onclick=()=>{mode='history';draw();};$('depth-tab').onclick=()=>{mode='depth';draw();};$('range').onchange=draw;$('direction').onchange=()=>{route=$('direction').value;rows();draw();};
$('cost-form').onsubmit=e=>{e.preventDefault();load(!histories?.single);};
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(selected)draw();},120);});
async function status(){
  try{
    const s=await api('/api/status');
    $('catalogue').textContent=`${s.count.toLocaleString()} indexed markets · ${s.time?'Catalogue '+new Date(s.time*1000).toLocaleString():'No catalogue yet'}${s.scanning?' · Refreshing…':''}${s.error?' · Refresh failed: '+s.error:''}`;
    $('rescan').disabled=s.scanning;
    if(s.scanning)setTimeout(status,3000);
  }catch(e){$('catalogue').textContent=e.message;}
}
$('rescan').onclick=async()=>{try{await fetch('/api/rescan',{method:'POST'});status();}catch(e){$('request-status').textContent=e.message;}};
async function starter(){
  if($('starter').childElementCount)return;
  try{const markets=await api('/api/search');$('starter').innerHTML=markets.filter(m=>m.paired&&!m.closed).slice(0,3).map(m=>`<button data-id="${esc(m.id)}" data-venue="${m.venue}"><span>${esc(m.title)}</span><small>Compare venues ↗</small></button>`).join('');}catch(e){$('request-status').textContent=e.message;}
}
$('starter').onclick=e=>{const b=e.target.closest('button');if(b)choose({id:b.dataset.id,venue:b.dataset.venue,title:b.querySelector('span').textContent});};
await status();
const query=new URLSearchParams(location.search);
if(query.has('venue')&&query.has('id'))choose({venue:query.get('venue'),id:query.get('id'),title:'Selected market'});
else starter();
