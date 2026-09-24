const NS = 'http://www.w3.org/2000/svg';
const valid = n => typeof n === 'number' && Number.isFinite(n);
const el = (name, attrs, text) => {
  const e = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value);
  if (text !== undefined) e.textContent = text;
  return e;
};

export function align(k = [], p = [], flip = false) {
  const cadence = a => {
    const gaps = a.slice(1).map((v, i) => v[0] - a[i][0]).filter(v => v > 0).sort((a, b) => a - b);
    return gaps.length ? gaps[Math.floor(gaps.length / 2)] * 2 : 3600000;
  };
  const hold = a => Math.min(Math.max(cadence(a), 86400000), 172800000);  // a price stays valid for a day, two for daily candles
  const ka = hold(k), pa = hold(p);
  const times = [...new Set([...k, ...p].map(a => a[0]))].sort((a, b) => a - b);
  let ki = -1, pi = -1;
  return times.map(t => {
    while (ki + 1 < k.length && k[ki + 1][0] <= t) ki++;
    while (pi + 1 < p.length && p[pi + 1][0] <= t) pi++;
    const a = ki >= 0 && t - k[ki][0] <= ka ? k[ki][1] : null;
    let b = pi >= 0 && t - p[pi][0] <= pa ? p[pi][1] : null;
    if (b !== null && flip) b = 1 - b;
    return [t, a, b];
  });
}

export function chart(container, points, {history = false, labels = [], colors = ['#43d9b0', '#72aaff'], edge = p => p[2] - p[1], edgeLabel = 'Net', domain, empty: message, onRead = () => {}} = {}) {
  container.replaceChildren();
  points = points.filter(p => valid(p[0]) && (valid(p[1]) || valid(p[2])));
  if (!points.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-chart';
    empty.textContent = message || (history ? 'No history available for this period.' : 'No priced depth available. Refresh books to retry.');
    container.append(empty);
    return;
  }
  const w = Math.max(container.clientWidth, 260), h = container.clientHeight, pad = {l:42, r:18, t:16, b:28};
  const svg = el('svg', {viewBox:`0 0 ${w} ${h}`, role:'img', 'aria-label':history ? 'Historical price comparison. Green where the gap is larger than both fees, red where it is not.' : 'Net edge between YES cost and the complementary NO cost ceiling.'});
  container.append(svg);
  const defs = el('defs', {});
  for (const [name, color] of [['up', '#22c55e'], ['down', '#ef4444']]) {
    const hatch = el('pattern', {id:container.id+'-'+name, width:6, height:6, patternUnits:'userSpaceOnUse', patternTransform:'rotate(45)'});
    hatch.append(el('rect', {width:6, height:6, fill:color, 'fill-opacity':.22}), el('line', {x1:0, y1:0, x2:0, y2:6, stroke:color, 'stroke-width':2, 'stroke-opacity':.85}));
    defs.append(hatch);
  }
  svg.append(defs);
  const tx = history ? v => v : Math.log10, from = history ? v => v : v => 10 ** v;
  const xmin = tx(Math.min(points[0][0], domain?.[0] ?? Infinity)), xmax = tx(Math.max(points.at(-1)[0], domain?.[1] ?? -Infinity));
  const values = points.flatMap(p => p.slice(1)).filter(valid);
  let lo = Math.min(...values), hi = Math.max(...values);
  const margin = Math.max((hi-lo) * .18, .015);
  lo = Math.max(0, Math.floor((lo-margin)*100)/100); hi = Math.min(1, Math.ceil((hi+margin)*100)/100);
  const x = v => pad.l + (xmax === xmin ? .5 : (tx(v)-xmin)/(xmax-xmin))*(w-pad.l-pad.r);
  const y = v => pad.t + (hi-v)/(hi-lo)*(h-pad.t-pad.b);
  const date = v => new Date(v).toLocaleDateString(undefined, xmax-xmin > 180*864e5 ? {month:'short',year:'numeric'} : {month:'short',day:'numeric'});
  for (let i=0; i<=4; i++) {
    const v=lo+(hi-lo)*i/4, yy=y(v);
    svg.append(el('line',{x1:pad.l,x2:w-pad.r,y1:yy,y2:yy,stroke:'#263240','stroke-width':.6}));
    svg.append(el('text',{x:pad.l-7,y:yy+3,fill:'#97a8bb','font-size':10,'text-anchor':'end'},`${(v*100).toFixed(0)}¢`));
  }
  const ticks = history ? [0,1,2,3,4].map(i => xmin+(xmax-xmin)*i/4) : [1,10,100,1000,10000].filter(v => tx(v) >= xmin && tx(v) <= xmax);
  for (const v of ticks) {
    const xx = x(v);
    svg.append(el('text',{x:xx,y:h-6,fill:'#97a8bb','font-size':9,'text-anchor':xx<pad.l+12?'start':xx>w-pad.r-12?'end':'middle'},history?date(v):v.toLocaleString()));
  }
  function fill(a,b) {
    const hatch = edge(a.map((v,j) => (v+b[j])/2)) > 0 ? 'up' : 'down';
    svg.append(el('path',{d:`M${x(a[0])},${y(a[1])}L${x(b[0])},${y(b[1])}L${x(b[0])},${y(b[2])}L${x(a[0])},${y(a[2])}Z`,fill:`url(#${container.id}-${hatch})`}));
  }
  for (let i=1;i<points.length;i++) {
    const a=points[i-1], b=points[i];
    if (![a[1],a[2],b[1],b[2]].every(valid)) continue;
    if (history) { fill(a,[b[0],a[1],a[2]]); continue; }
    const da=a[2]-a[1], db=b[2]-b[1];
    if (da*db<0) {
      const f=da/(da-db), cross=a.map((v,j)=>v+(b[j]-v)*f);
      cross[0]=from(tx(a[0])+(tx(b[0])-tx(a[0]))*f);
      fill(a,cross); fill(cross,b);
    } else fill(a,b);
  }
  for (const [j,color] of [[1,colors[0]],[2,colors[1]]]) {
    let d='', previous=null;
    for (const p of points) {
      if (!valid(p[j])) {previous=null;continue;}
      d += previous ? (history?`H${x(p[0])}V${y(p[j])}`:`L${x(p[0])},${y(p[j])}`) : `M${x(p[0])},${y(p[j])}`;
      previous=p;
    }
    svg.append(el('path',{d,fill:'none',stroke:color,'stroke-width':1.7,'stroke-linejoin':'round',pathLength:1,class:'chart-line'}));
    if (points.length===1 && valid(points[0][j])) svg.append(el('circle',{cx:x(points[0][0]),cy:y(points[0][j]),r:3,fill:color}));
  }
  const cursor=el('line',{x1:0,x2:0,y1:pad.t,y2:h-pad.b,stroke:'#97a8bb','stroke-dasharray':'3 3',visibility:'hidden'});
  svg.append(cursor);
  let current=points.length-1;
  function read(i) {
    current=Math.max(0,Math.min(points.length-1,i));
    const p=points[current];
    cursor.setAttribute('x1',x(p[0]));cursor.setAttribute('x2',x(p[0]));cursor.setAttribute('visibility','visible');
    const value=n=>valid(n)?`${(n*100).toFixed(2)}¢`:'—';
    onRead(`${history?new Date(p[0]).toLocaleString():p[0].toLocaleString()+' contracts'} · ${labels[0]||'A'} ${value(p[1])} · ${labels[1]||'B'} ${value(p[2])}${valid(p[1])&&valid(p[2])?` · ${edgeLabel} ${value(edge(p))}`:''}`);
  }
  svg.addEventListener('pointermove',e=>{
    const position=e.clientX-svg.getBoundingClientRect().left;
    let nearest=0;
    for(let i=1;i<points.length;i++) if(Math.abs(x(points[i][0])-position)<Math.abs(x(points[nearest][0])-position)) nearest=i;
    read(nearest);
  });
  container.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();read(current+(e.key==='ArrowLeft'?-1:1));}};
}
