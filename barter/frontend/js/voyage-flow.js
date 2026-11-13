import { state } from './state.js';
const key = 'bdo-voyage-flow-v2';
let hydrated = false;
let flow = { epoch: null, execution: false, comparisonScroll: 0, modes: {} };
try { const saved = JSON.parse(sessionStorage.getItem(key)); if (saved && typeof saved === 'object' && saved.modes && typeof saved.modes === 'object') flow = saved; } catch {}
export const actionable = trade => trade.isWaypoint || trade.execC !== 0;
export const tripComplete = sortie => (sortie.trades || []).every(t => !actionable(t) || t.completed === true);
const signature = sortie => JSON.stringify((sortie.trades || []).filter(t => !t.isWaypoint).map(t => [t.originalIndex,t.island,t.fromClean,t.toClean]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
export function saveVoyageFlow(persist = true) {
 if(state.session.schedule && flow.epoch === JSON.stringify([state.session.id,state.session.diagnostics?.generatedAt,state.session.config?.ship?.mode])) {
  state.session.selection ||= {};
  const saved={epoch:flow.epoch,execution:flow.execution,comparisonScroll:0,modes:Object.fromEntries(Object.entries(flow.modes).map(([mode,f])=>[mode,{...f,view:f.active,viewToken:f.activeToken,inspectCargo:false,scroll:{}}]))};
  const changed=JSON.stringify(state.session.selection.voyage)!==JSON.stringify(saved);state.session.selection.voyage=saved;
  if(persist&&changed)window.dispatchEvent(new CustomEvent('bdo:session-changed'));
 }
 try{sessionStorage.setItem(key,JSON.stringify(flow));}catch{}
}
export function briefingFlow() {
  if (!state.session.id && !state.session.schedule && !hydrated) return { execution: false, comparisonScroll: 0, modes: {} };
  hydrated = true;
  const epoch = JSON.stringify([state.session.id,state.session.diagnostics?.generatedAt,state.session.config?.ship?.mode]);
  if(flow.epoch!==epoch && state.session.selection?.voyage?.epoch===epoch) flow=state.session.selection.voyage;
  if (flow.epoch !== epoch || !state.session.schedule) flow = { epoch, execution: false, comparisonScroll: 0, modes: {} };
  return flow;
}
export function voyageFlow(mode, sorties) {
  const shared = briefingFlow();
  let f = shared.modes[mode];
  if (!f || !Number.isInteger(f.active) || !Number.isInteger(f.view) || !['cargo','route','return','finished'].includes(f.phase)) {
    const first = sorties.findIndex(s => !tripComplete(s));
    const index = first < 0 ? sorties.length-1 : first;
    f = shared.modes[mode] = { active: Math.max(0,index), view: Math.max(0,index), phase: first < 0 ? 'return' : sorties[index].trades.some(t => t.completed) ? 'route' : 'cargo', inspectCargo: false, scroll: {} };
  }
  const current = f.activeToken && (sorties[f.active] && signature(sorties[f.active]) === f.activeToken ? f.active : sorties.findIndex(s => signature(s) === f.activeToken));
  if (typeof current === 'number' && current >= 0) f.active = current;
  const viewed = f.viewToken && (sorties[f.view] && signature(sorties[f.view]) === f.viewToken ? f.view : sorties.findIndex(s => signature(s) === f.viewToken));
  if (typeof viewed === 'number' && viewed >= 0) f.view = viewed;
  f.active = Math.max(0,Math.min(f.active,sorties.length-1));
  f.view = Math.max(0,Math.min(f.view,sorties.length-1));
  f.scroll ||= {};
  if (f.phase !== 'finished' && tripComplete(sorties[f.active])) f.phase = 'return';
  if (['return','finished'].includes(f.phase) && !tripComplete(sorties[f.active])) f.phase = 'route';
  f.activeToken = signature(sorties[f.active]); f.viewToken = signature(sorties[f.view]);
  return f;
}
export function viewTrip(f, index, sorties) { f.view = index; f.viewToken = signature(sorties[index]); f.inspectCargo = false; saveVoyageFlow(false); }
export function returnFromTrip(f, sorties) {
  if (!tripComplete(sorties[f.active])) return false;
  if (f.active+1 < sorties.length) { f.active++; f.phase = 'cargo'; } else f.phase = 'finished';
  f.activeToken = signature(sorties[f.active]); viewTrip(f,f.active,sorties); saveVoyageFlow(); return true;
}
window.addEventListener('pagehide',()=>saveVoyageFlow(false));
