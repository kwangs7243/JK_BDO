import {state} from './state.js';
import {hasUnresolvedPersistence} from './persistence.js';

export function renderScenarioUI() {
  const session = state.session, rows = session.scannedTrades;
  const plan = session.selection?.plan;
  const requested = plan?.lockedMode || session.selection?.briefMode;
  const selected = requested === 'balance' ? 'balance' : 'speed';
  const voyage = session.selection?.voyage;
  const executing = !!plan?.lockedMode || !!voyage?.execution;
  const flow = voyage?.modes?.[selected];
  const metrics = document.getElementById('brief-remaining-metrics');
  if (metrics && metrics.parentElement !== document.querySelector('.briefing-body')) document.querySelector('.briefing-body').append(metrics);
  const hasRound = rows !== null, exists = !!session.schedule;
  document.body.dataset.roundState = hasRound ? 'ready' : 'empty';
  document.body.dataset.planStage = executing ? 'execution' : 'preparation';
  const count = document.getElementById('scenario-round');
  if (!count) return;
  count.textContent = hasRound
    ? `현재 회차 · 사용 ${rows.filter(t => !t.deleted && !t.disabled).length}행 · 제외 ${rows.filter(t => !t.deleted && t.disabled).length}행`
    : '현재 회차 · 목록 없음';
  const progress = document.getElementById('scenario-progress');
  const phases = {cargo:'적재 준비', route:'항로 수행', return:'일리야 복귀', finished:'선택한 계획 완료'};
  progress.textContent = executing && flow
    ? `${selected === 'speed' ? '쾌속' : '균형'} · ${flow.phase === 'finished' ? phases.finished : `${flow.active + 1}차 · ${phases[flow.phase] || '항로 수행'}`}`
    : exists ? '출항 계획 비교' : hasRound ? '목록 확인' : '새 회차 준비';
  document.getElementById('scenario-parley').textContent = hasRound && Number.isSafeInteger(session.remainingParley)
    ? session.remainingParley.toLocaleString() : '—';
  const dirty = !!plan?.dirtyReasons?.length;
  const blocked = hasUnresolvedPersistence() || state.persistencePending > 0;
  const save = document.getElementById('scenario-save');
  save.textContent = state.persistenceIssue || window.__bdoScheduleRuntime?.completionPending ? '저장 결과 확인 필요'
    : state.sessionUnsaved && !state.persistencePending ? '미저장 변경 있음'
    : state.persistencePending ? '저장 중' : state.revision === null ? '불러오는 중' : '저장됨';
  save.dataset.kind = blocked ? 'pending' : 'saved';
  const notice = document.getElementById('scenario-plan-notice');
  notice.hidden = !dirty;
  document.getElementById('scenario-changes').textContent = dirty ? plan.dirtyReasons.join(' · ') : '';
  const recalculate = document.getElementById('brief-recalculate');
  const parent = dirty ? notice : document.querySelector('.briefing-heading');
  if (recalculate.parentElement !== parent) parent.append(recalculate);
  recalculate.textContent = dirty ? '변경 확인 · 재계산' : exists ? '남은 계획 재계산' : '브리핑 만들기';
  recalculate.disabled = blocked || !hasRound || window.__bdoPlanBusy === true;
  document.querySelectorAll('.route-complete-button').forEach(button => {
    if (blocked || dirty) {
      if (!Object.hasOwn(button.dataset, 'scenarioDisabled')) button.dataset.scenarioDisabled = String(button.disabled);
      button.disabled = true;
    } else if (Object.hasOwn(button.dataset, 'scenarioDisabled')) {
      button.disabled = button.dataset.scenarioDisabled === 'true';
      delete button.dataset.scenarioDisabled;
    }
  });
  const nav = document.querySelector('.workspace-nav [data-workspace-view=briefing]');
  const label = executing ? '진행 항로' : '출항 브리핑';
  if (nav.lastChild?.nodeType === Node.TEXT_NODE) nav.lastChild.textContent = label;
  const back = document.getElementById('inventory-return-voyage');
  back.hidden = !exists;
  back.textContent = executing ? '진행 항로로 돌아가기 →' : '계획 선택으로 돌아가기 →';
}

export function initScenarioUI() {
  document.querySelector('.briefing-heading').append(document.getElementById('brief-back-compare'));
  document.querySelector('.scenario-context').after(document.getElementById('runtime-status'));
  document.getElementById('inventory-return-voyage').onclick = () => window.__bdoOpenBriefing();
  document.querySelector('.inventory-toolbar').after(document.querySelector('.warehouse-tier-menu'));
  window.__bdoRenderScenarioUI = renderScenarioUI;
  new MutationObserver(renderScenarioUI).observe(document.getElementById('runtime-status'), {subtree:true, childList:true, characterData:true});
  renderScenarioUI();
}
