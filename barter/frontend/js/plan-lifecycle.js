import { state } from './state.js';
import { saveWorkingSession, whenPersistenceIdle } from './persistence.js';
import { confirmAction } from '/portal-assets/feedback.js';
import { inventoryIcon } from './inventory-ui.js';
let busy=false, requesting=false, generate;
const configKey=value=>JSON.stringify({...value,parley:{normalCost:value.parley?.normalCost,crowCost:value.parley?.crowCost}},(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const plan=()=>{state.session.selection ||= {};return state.session.selection.plan ||= {dirtyReasons:[]};};
export function lockedPlan(){return state.session.selection?.plan?.lockedMode || ['speed','balance'].find(m=>state.session.schedule?.[m]?.some(s=>s.trades.some(t=>t.completed)));}
export function markPlanChanged(reason){if(!state.session.schedule)return;const p=plan();p.dirtyReasons=[...new Set([...(p.dirtyReasons||[]),reason])].slice(0,20);renderPlanStatus();}
function checkInputs(){
 if(!state.session.schedule)return;
 const p=plan();p.config ||= configKey(state.session.config);p.inventory ||= Object.fromEntries(state.inventory.map(i=>[i.programName,i.stock]));if(p.config && configKey(state.session.config)!==p.config)markPlanChanged('교역·선박·교섭 비용 설정 변경');
 if(p.inventory){const names=new Set((lockedPlan()?[state.session.schedule[lockedPlan()]]:Object.values(state.session.schedule)).flatMap(ss=>ss.flatMap(s=>s.trades.filter(t=>!t.completed).map(t=>t.isWaypoint?t.consumed?.name:t.fromClean))));if(state.inventory.some(i=>names.has(i.programName)&&p.inventory[i.programName]!=null&&(i.stock==null||i.stock<p.inventory[i.programName])))markPlanChanged('필요 품목 재고 감소');}
}
function remainingSummary(mode){
 const rows=(state.session.schedule?.[mode]||[]).flatMap(s=>s.trades).filter(t=>!t.completed);const parley=state.session.config?.parley||{};
 const cost=rows.reduce((n,t)=>n+(t.isWaypoint?0:t.execC*(t.isCoin?parley.crowCost:parley.normalCost)),0),coins=rows.reduce((n,t)=>n+(!t.isWaypoint&&(t.isCoin||t.toTier==='coin')?t.execC*t.mult:0),0);
 return {rows,cost,coins};
}
function showSelectedSettlement() {
 const mode = lockedPlan();
 if (!mode) return;
 const dialog = document.createElement('dialog');
 dialog.className = 'app-dialog brief-selected-ledger';
 const heading = document.createElement('h2');
 heading.id = 'brief-selected-ledger-title';
 heading.textContent = `${mode === 'speed' ? '쾌속' : '균형'} · 남은 계획 창고결산`;
 dialog.setAttribute('aria-labelledby', heading.id);
 const note = document.createElement('p');
 note.textContent = '앞으로 수행할 교환의 1~5단 품목 순증감입니다. 이미 완료한 교환은 현재 재고에 반영되어 있습니다.';
 const deltas = new Map();
 const add = (name, tier, amount) => {
  if (Number(tier) < 1 || Number(tier) > 5 || !Number(tier)) return;
  const item = deltas.get(name) || {name, tier: Number(tier), amount: 0};
  item.amount += amount; deltas.set(name, item);
 };
 for (const trade of remainingSummary(mode).rows) {
  if (trade.isWaypoint) {
   if (trade.consumed) add(trade.consumed.name, trade.consumed.tier, -trade.consumed.count);
  } else {
   add(trade.fromClean, trade.fromTier, -trade.execC * trade.reqA);
   add(trade.toClean, trade.toTier, trade.execC * trade.mult);
  }
 }
 const table = document.createElement('table');
 table.className = 'brief-ledger-table';
 const head = table.createTHead().insertRow();
 for (const caption of ['품목', '앞으로의 증감']) {
  const th = document.createElement('th'); th.scope = 'col'; th.textContent = caption; head.append(th);
 }
 const body = table.createTBody();
 for (const item of [...deltas.values()].filter(i => i.amount).sort((a,b) => a.tier-b.tier || a.name.localeCompare(b.name,'ko'))) {
  const row = body.insertRow();
  const name = row.insertCell(); name.className = 'brief-selected-ledger-item';
  const icon = inventoryIcon(item.name);
  if (icon) { const img = document.createElement('img'); img.src = icon; img.alt = ''; img.onerror = () => img.remove(); name.append(img); }
  name.append(document.createTextNode(`${item.tier}단 · ${item.name}`));
  const amount = row.insertCell(); amount.textContent = `${item.amount>0?'+':''}${item.amount.toLocaleString()}`;
  amount.className = item.amount>0 ? 'brief-positive' : 'brief-negative';
 }
 const close = document.createElement('button'); close.type = 'button'; close.textContent = '닫기'; close.onclick = () => dialog.close();
 dialog.append(heading, note, table, close);
 dialog.addEventListener('close', () => dialog.remove(), {once:true});
 document.body.append(dialog); dialog.showModal(); close.focus();
}
export function renderPlanStatus(){
 const locked=lockedPlan(),dirty=plan().dirtyReasons?.length,exists=!!state.session.schedule;
 if(locked){state.session.selection.briefMode=locked;document.getElementById('schedule-columns').dataset.mode=locked;}
 const remaining=state.session.scannedTrades?.filter(t=>!t.disabled&&!t.deleted&&t.count>0).length||0;
 const flow=state.session.selection?.voyage?.modes?.[locked];
 const finished=locked&&flow?.phase==='finished';
 const progress=flow?`${flow.active+1}차 · ${{cargo:'적재 준비',route:'항로 수행',return:'일리야 복귀',finished:'수행 완료'}[flow.phase]}`:'항로 수행';
 const empty=exists&&!Object.values(state.session.schedule).some(ss=>ss.length);
 const text=state.session.scannedTrades===null?'게임 물교 목록을 가져오세요.':dirty?`${plan().dirtyReasons.join(' · ')} · 재계산 필요`:finished?`선택한 계획 수행 완료 · 남은 교환 ${remaining}행 · 추가 계산 또는 새 회차 준비`:empty?'현재 조건으로 출항 가능한 계획이 없습니다. 재고·교환 제외·교섭력을 확인하세요.':locked?`${locked==='speed'?'쾌속':'균형'} 진행 중 · ${progress} · 회차 남은 교환 ${remaining}행`:exists?'출항 전 · 두 계획의 창고결산과 항로를 비교하세요.':'회차 준비 완료 · 저장된 교역 모드로 브리핑을 만듭니다.';
 for(const id of ['round-plan-status','brief-plan-status'])document.getElementById(id).textContent=text;
 const label=dirty?'변경 반영해 재계산':!exists?'브리핑 만들기':finished?'완료한 계획 보기':locked?'진행 항로 이어보기':'브리핑 보기';
 document.getElementById('open-schedule').textContent=label;
 const button=document.getElementById('brief-recalculate');button.textContent=exists?'남은 교환으로 재계산':'브리핑 만들기';button.disabled=busy||state.session.scannedTrades===null;
 const totals=locked?remainingSummary(locked):null;
 let metrics=document.getElementById('brief-remaining-metrics');if(!metrics){metrics=document.createElement('p');metrics.id='brief-remaining-metrics';document.querySelector('.brief-lifecycle-bar').after(metrics);}
 metrics.hidden=!locked;metrics.textContent=locked?`남은 계획 교섭력 ${totals.cost.toLocaleString()} · 현재 잔여 ${Number(state.session.remainingParley).toLocaleString()} · 까마귀주화 추가 ${totals.coins.toLocaleString()}개`:'';
 document.getElementById('briefing-panel').classList.toggle('plan-needs-update',!!dirty);
 document.querySelectorAll('[data-brief-mode]').forEach(b=>b.disabled=!!locked&&b.dataset.briefMode!==locked);
 for(const mode of ['speed','balance'])for(const prefix of ['open-map-','brief-map-']){const button=document.getElementById(prefix+mode);if(button){button.hidden=!!locked&&mode!==locked;button.textContent=locked?'진행 항로 지도':`${mode==='speed'?'쾌속':'균형'} 항로 지도`;}}
 document.getElementById('brief-plan-status').setAttribute('role','status');
}
export async function requestPlan(options={}) {
 if(requesting)return false;
 requesting=true;
 try{return await replacePlan(options);}finally{requesting=false;}
}
async function replacePlan({force=false,mode=null}={}){
 if(busy||state.session.scannedTrades===null)return false;
 if(window.__bdoScheduleRuntime.pending){window.showToast('완료 저장을 먼저 확인하세요.');return false;}
 await whenPersistenceIdle();checkInputs();
 const locked=lockedPlan(),dirty=plan().dirtyReasons?.length;
 if(state.session.schedule&&!force&&!dirty){renderPlanStatus();return true;}
 const revision=state.sessionRevision,id=state.session.id;
 if(state.session.schedule&&(locked||dirty)&&!await confirmAction('현재 남은 교환·교섭력·재고로 계획을 새로 계산합니다. 새 계획은 일리야 복귀·하역·재적재 후 출항 기준이며, 현재 해상 위치에서 바로 이어지는 항로가 아닙니다. 기존 남은 계획을 교체할까요?',{title:'남은 계획 재계산',acceptLabel:'재계산',cancelLabel:'기존 상태 유지'}))return false;
 if(revision!==state.sessionRevision||id!==state.session.id){window.showToast('확인 중 회차가 바뀌었습니다. 다시 확인하세요.');return false;}
 busy=true;renderPlanStatus();const before=structuredClone(state.session);
 try{
  if(mode)state.session.config.ship.mode=mode;
  window.__bdoPlanGenerating=true;
  if(!state.session.scannedTrades.some(t=>!t.disabled&&!t.deleted&&t.count>0)){state.session.schedule={speed:[],balance:[]};state.session.completed={speed:[],balance:[]};state.session.timers={};state.session.diagnostics={generatedAt:Date.now(),generationId:crypto.randomUUID(),mode:state.session.config.ship.mode,emptyReason:'사용할 교환 없음'};window.dispatchEvent(new CustomEvent('bdo:timers-reset'));}
  else if(!generate(state,message=>window.showToast(message))) {state.session=before;return false;}
  state.session.selection.plan={lockedMode:null,dirtyReasons:[],config:configKey(state.session.config),inventory:Object.fromEntries(state.inventory.map(i=>[i.programName,i.stock]))};
  delete state.session.selection.voyage;
  window.__bdoPlanGenerating=false;
  await saveWorkingSession();document.getElementById('schedule-status').textContent='';window.__bdoRenderAll?.();return true;
 }catch(error){if(error.committed){window.showToast('새 계획 저장은 완료됐으나 재조회에 실패했습니다. 새로고침해 확인하세요.');return true;}state.session=before;window.__bdoScheduleRuntime.syncLegacyState(state);window.showToast(`새 계획을 적용하지 못했습니다. 기존 상태를 유지합니다: ${error.message}`);return false;}
 finally{window.__bdoPlanGenerating=false;busy=false;window.__bdoScheduleRuntime.syncLegacyState(state);window.__bdoRenderAll?.();renderPlanStatus();}
}
export function initPlanLifecycle(){
 generate=window.__bdoScheduleRuntime.generateSchedule;
 window.__bdoScheduleRuntime.generateSchedule=(s,status)=>{if(s.session.schedule){if(plan().config===configKey(s.session.config)){status('설정을 저장했습니다. 현재 계획은 유지합니다.','success');return false;}markPlanChanged('계산 설정 변경');status('진행 중인 계획은 재계산 확인 후 교체할 수 있습니다.','info');return false;}return generate(s,status);};
 window.__bdoLockedPlan=lockedPlan;window.__bdoMarkPlanChanged=markPlanChanged;window.__bdoRenderPlanStatus=()=>{checkInputs();renderPlanStatus();};
 window.__bdoEnterBriefing=()=>requestPlan();
 document.getElementById('v-show-settlement').addEventListener('click',showSelectedSettlement);
 document.getElementById('brief-recalculate').onclick=()=>requestPlan({force:true});
 window.addEventListener('bdo:session-changed',renderPlanStatus);
 renderPlanStatus();
}
