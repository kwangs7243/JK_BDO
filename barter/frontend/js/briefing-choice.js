import { briefingFlow, saveVoyageFlow, viewTrip } from './voyage-flow.js';
import { state } from './state.js';
import { inventoryIcon } from './inventory-ui.js';

const make = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
const amount = n => Number(n).toLocaleString('ko-KR');
const selectedMode = () => state.session.selection?.briefMode === 'balance' ? 'balance' : 'speed';
function showExecution(value, persist = false) {
  const flow = briefingFlow(); flow.execution = value; saveVoyageFlow(persist);
  const panel = document.getElementById('briefing-panel');
  panel.dataset.stage = value ? 'execution' : 'compare';
  document.getElementById('brief-back-compare').hidden = !value;
  document.getElementById('brief-selected-plan').hidden = !value;
  if (!value) document.querySelector('.brief-plan-comparison').scrollTop = flow.comparisonScroll;
}
export function renderBriefingChoice() {
  const ledger = document.getElementById('brief-ledger');
  if (!ledger) return;
  const locked=window.__bdoLockedPlan?.();
  showExecution(Boolean(locked)||briefingFlow().execution);
  document.getElementById('brief-back-compare').hidden=Boolean(locked)||!briefingFlow().execution;
  window.__bdoRenderPlanStatus?.();
  const mode = selectedMode(), label = mode === 'speed' ? '쾌속' : '균형';
  const source = document.querySelector(`[data-brief-mode="${mode}"]`);
  document.getElementById('brief-selected-plan').textContent = `${label} · ${source?.querySelector('.v-compare-stat')?.textContent || ''}`;
  document.getElementById('brief-choice-label').textContent = `${label} 선택 · 적재와 항로를 확인합니다`;
  const confirm = document.getElementById('brief-confirm-plan');
  confirm.disabled = !state.session.schedule?.[mode]?.length;
  confirm.textContent = `${label}으로 출항 준비 →`;
  ledger.replaceChildren(make('h3', '', '창고 결산 비교'), make('p', 'brief-ledger-note', '전체 계획의 1~5단 품목 순증감 · 현재 재고는 진행 중인 교환을 반영한 값입니다.'));
  const entries = new Map();
  for (const key of ['speed','balance']) for (const entry of document.querySelectorAll(`#summary-${key} .settlement-entry`)) {
    const { name, tier } = entry.dataset;
    if (!entries.has(name)) entries.set(name, { name, tier: Number(tier), speed: 0, balance: 0 });
    entries.get(name)[key] = Number(entry.dataset.amount);
  }
  if (!state.session.schedule || !entries.size) { ledger.append(make('p','brief-ledger-empty',state.session.schedule ? '창고 1~5단 순증감 품목이 없습니다.' : '브리핑 만들기를 눌러 저장된 교역 모드로 계산하세요.')); return; }
  const table = make('table','brief-ledger-table');
  table.dataset.selected = mode;
  const head = table.createTHead().insertRow();
  for (const caption of ['품목','현재','쾌속 증감','균형 증감']) { const th = make('th','',caption); th.scope = 'col'; head.append(th); }
  const stocks = new Map(state.inventory.map(item => [item.programName,item.stock]));
  const body = table.createTBody();
  for (const item of [...entries.values()].sort((a,b) => a.tier-b.tier || a.name.localeCompare(b.name,'ko'))) {
    const row = body.insertRow(); row.classList.toggle('brief-ledger-different',item.speed !== item.balance);
    const name = make('th','brief-ledger-item'); name.scope = 'row';
    const content = make('span','brief-ledger-item-content');
    const icon = inventoryIcon(item.name);
    if (icon) { const img = make('img',''); img.src = icon; img.alt = ''; img.loading = 'lazy'; img.onerror = () => img.remove(); content.append(img); }
    const copy = make('span',''); copy.append(make('small','',`${item.tier}단`),make('span','',item.name)); content.append(copy); name.append(content); row.append(name);
    row.insertCell().textContent = stocks.get(item.name) == null ? '미확인' : amount(stocks.get(item.name));
    for (const key of ['speed','balance']) { const cell = row.insertCell(); cell.className = item[key] > 0 ? 'brief-positive' : item[key] < 0 ? 'brief-negative' : ''; cell.textContent = item[key] ? `${item[key]>0?'+':'−'}${amount(Math.abs(item[key]))}` : '—'; }
  }
  ledger.append(table);
}
export function initBriefingChoice() {
  document.getElementById('brief-ledger').tabIndex = -1;
  document.getElementById('brief-confirm-plan').onclick = () => {
    if (window.__bdoScheduleRuntime?.pending || state.persistencePending > 0) { window.showToast('저장이 끝난 뒤 출항 준비를 진행하세요.'); return; }
    if (!state.session.schedule?.[selectedMode()]?.length) return;
    briefingFlow().comparisonScroll = document.querySelector('.brief-plan-comparison').scrollTop;
    showExecution(true,true);
    const mode = selectedMode(), active = briefingFlow().modes[mode];
    if (active) { viewTrip(active,active.active,state.session.schedule[mode]); window.renderModeColumn(`col-${mode}`,state.session.schedule[mode],mode); }
    document.querySelector(`#col-${selectedMode()} .sortie-card:not([hidden]) .v-show-route, #col-${selectedMode()} .sortie-card:not([hidden]) .route-complete-button`)?.focus({preventScroll:true});
  };
  document.getElementById('brief-back-compare').onclick = () => {
    if(window.__bdoLockedPlan?.())return;
    showExecution(false,true);
    document.querySelector(`[data-brief-mode="${selectedMode()}"]`)?.focus({preventScroll:true});
  };
  renderBriefingChoice();
}
