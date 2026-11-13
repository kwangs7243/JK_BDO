import { actionable } from './voyage-flow.js';
import { state } from './state.js';
import { requestSessionReset } from './trade-ui.js';

const completePlan = (session, mode) => {
  const rows = session.schedule?.[mode]?.flatMap(sortie => sortie.trades ?? []);
  return rows?.length > 0 && rows.every(trade => !actionable(trade) || trade.completed === true);
};

export function syncRoundResetButton() {
  const button = document.getElementById('v-reset-round');
  if (button) button.disabled = state.session.scannedTrades === null || !!window.__bdoScheduleRuntime?.pending;
}

function requestRoundCompletion() {
  const mode = state.session.selection?.briefMode === 'balance' ? 'balance' : 'speed';
  const id = state.session.id;
  if (!id || !completePlan(state.session, mode)) return;
  const generation = state.session.diagnostics?.generatedAt ?? '';
  const stillComplete = () => state.session.id === id
    && (state.session.diagnostics?.generatedAt ?? '') === generation
    && completePlan(state.session, mode);
  if (!stillComplete() || window.__bdoScheduleRuntime?.pending || state.persistencePending > 0) return;
  if(state.session.scannedTrades?.some(t=>!t.deleted&&!t.disabled&&t.count>0)){window.showToast('선택한 계획을 마쳤습니다. 남은 교환으로 재계산하거나 회차 초기화로 새 회차를 준비하세요.');return;}
  requestSessionReset({ completed: true, stillValid: stillComplete });
}

window.addEventListener('bdo:round-returned', requestRoundCompletion);
