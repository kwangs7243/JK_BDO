import { state } from './state.js';
import { requestSessionReset } from './trade-ui.js';

const completePlan = (session, mode) => {
  const rows = session.schedule?.[mode]?.flatMap(sortie => sortie.trades ?? []);
  return rows?.length > 0 && rows.every(trade => trade.completed === true);
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
  requestSessionReset({ completed: true, stillValid: stillComplete });
}

window.addEventListener('bdo:round-returned', requestRoundCompletion);
