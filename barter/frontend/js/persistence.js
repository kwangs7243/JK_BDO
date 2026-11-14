import {confirmAction} from '/portal-assets/feedback.js';
import { api } from "./api.js";
import { applyBootstrap, state } from "./state.js";

let mutationQueue = Promise.resolve();
let sessionEditVersion = 0;
const createMutationId = () => crypto.randomUUID();
const runtime = () => window.__bdoScheduleRuntime;

export async function refreshPersistentState({ restoreSession = false } = {}) {
  if (restoreSession) {
    await whenPersistenceIdle();
    if (runtime()?.completionPending) throw new Error('완료 저장 결과를 먼저 확인하세요.');
  }
  const snapshot = applyBootstrap(await api.bootstrap());
  if (restoreSession) runtime().restoreWorkingSession(state, snapshot.workingSession);
  return snapshot;
}

function enqueue(operation) {
  state.persistencePending++;
  const result = mutationQueue.then(operation).finally(() => {
    state.persistencePending--;
    renderPersistenceRecovery();
  });
  mutationQueue = result.catch(() => undefined);
  return result;
}

export const whenPersistenceIdle = () => mutationQueue;

function assertMutable() {
  if (api.hasPendingRequest() || state.persistenceIssue) throw new Error('앞선 저장 결과를 먼저 확인하세요.');
  if (runtime()?.pending) throw new Error("완료 저장을 먼저 확인하거나 재시도하세요. 다른 회차 변경은 대기합니다.");
}

function enqueueMutation(send, { sessionGeneration, onCommitted } = {}) {
  assertMutable();
  return enqueue(async () => {
    assertMutable();
    if (sessionGeneration !== undefined && sessionGeneration !== state.sessionGeneration) {
      throw new Error("현재 회차를 다시 불러와 이전 편집은 저장하지 않았습니다. 현재 화면에서 다시 작업하세요.");
    }
    const baseRevision = state.revision;
    if (!Number.isSafeInteger(baseRevision)) throw new Error("저장 버전을 먼저 불러와야 합니다.");
    const mutationId = createMutationId();
    try {
      const result = await send({ mutationId, baseRevision });
      state.revision = result.revision;
      onCommitted?.(result);
      try {
        await refreshPersistentState();
      } catch (reloadError) {
        const error = new Error(`서버 저장은 확인됐지만 최신 상태 재조회가 실패했습니다: ${reloadError.message}`); error.committed = true; throw error;
      }
      return result;
    } catch (error) {
      // Conflict/error never becomes a local success. Re-read only to display current server state.
      if (error.status === 409) {
        try { await refreshPersistentState(); } catch { /* retain last confirmed in-memory state */ }
      }
      if (error.uncertain || error.committed) {
        state.persistenceIssue = {message: error.message, committed: !!error.committed, restoreSession: sessionGeneration !== undefined};
        renderPersistenceRecovery();
      }
      throw error;
    }
  });
}

export const saveInventory = (items) => enqueueMutation(({ mutationId, baseRevision }) => api.patchInventory({ mutationId, baseRevision, kind: "manual", patch: { items } }));
export const saveWarehouseInventory = (items, feedback) => enqueueMutation(({ mutationId, baseRevision }) => api.patchInventory({
  mutationId,
  baseRevision,
  kind: "warehouse",
  patch: { type: "master_inventory_patch", version: 1, items },
  ...(feedback ? { feedback } : {}),
}));
export const saveInventoryOrder = (order) => enqueueMutation(({ mutationId, baseRevision }) => api.saveInventoryOrder({ mutationId, baseRevision, order }));
export const saveSettings = (settings) => enqueueMutation(({ mutationId, baseRevision }) => api.patchSettings({ mutationId, baseRevision, settings }));

export function saveWorkingSession() {
  assertMutable();
  const session = runtime().snapshotWorkingSession(state);
  if (!session) return Promise.resolve();
  let generation;
  try { generation = runtime().scheduleRecordFor?.(session); } catch { /* Recording cannot block the working save. */ }
  const savedEditVersion = sessionEditVersion;
  return enqueueMutation((envelope) => api.saveWorkingSession({ ...envelope, session,
    ...(generation ? {generation} : {}), sessionRevision: state.sessionBaseRevision }), {
    sessionGeneration: state.sessionGeneration,
    onCommitted: (result) => {
      state.sessionBaseRevision = result.revision;
      if (sessionEditVersion === savedEditVersion) state.sessionUnsaved = false;
      renderPersistenceRecovery();
    },
  });
}

export async function resetWorkingSession() {
  await enqueueMutation((envelope) => api.resetWorkingSession({ ...envelope, sessionRevision: state.sessionBaseRevision }), {
    sessionGeneration: state.sessionGeneration,
    onCommitted: () => runtime().restoreWorkingSession(state, null, null),
  });
  window.dispatchEvent(new CustomEvent("bdo:trade-list-changed"));
  window.__bdoRenderAll?.();
}

export function saveScheduleSlot(slot) {
  assertMutable();
  const session = runtime().snapshotWorkingSession(state);
  if (!session?.schedule || !session.schedule.speed.length && !session.schedule.balance.length) throw new Error("저장할 스케줄 데이터가 없습니다.");
  const snapshot = { version: 1, createdAt: Date.now(), session };
  return enqueueMutation((envelope) => api.saveScheduleSlot(slot, { ...envelope, snapshot }));
}

export async function loadScheduleSlot(slot) {
  assertMutable();
  await whenPersistenceIdle();
  await refreshPersistentState();
  const snapshot = state.scheduleSlots[String(slot)];
  if (!snapshot) throw new Error(`${slot}번 슬롯이 비어 있습니다.`);
  const session = JSON.parse(JSON.stringify(snapshot.session));
  session.id = createMutationId();
  session.selection = { ...session.selection, selectedScheduleSlot: Number(slot) };
  const sessionRevision = state.sessionRevision;
  await enqueueMutation((envelope) => api.saveWorkingSession({ ...envelope, session, sessionRevision }), {
    sessionGeneration: state.sessionGeneration,
    onCommitted: (result) => runtime().restoreWorkingSession(state, session, result.revision),
  });
  window.__bdoRenderAll?.();
}

export const deleteScheduleSlot = (slot) => enqueueMutation((envelope) => api.deleteScheduleSlot(slot, envelope));

// Exact-body retries resolve uncertain response loss using bounded server receipts.
// Reconciliation is allowed only for inventory edits while this working session is unchanged.
export function saveCompletionInventory(request) {
  return enqueue(async () => {
    if (request.beforeInventory && !Object.hasOwn(request, "inventoryDeltas")) {
      // Rebasing mutates the request's absolute stocks; retries must retain the original consumption/gain.
      Object.defineProperty(request, "inventoryDeltas", { value: Object.freeze(Object.fromEntries(
        Object.entries(request.patch.items).map(([name, update]) => [name, update.stock - request.beforeInventory[name]])
      )), enumerable: false });
    }
    if (!request.session) request.session = runtime().snapshotWorkingSession(state);
    if (request.sessionRevision === undefined) {
      request.baseRevision = state.revision;
      request.sessionRevision = state.sessionBaseRevision;
    }
    const send = async (body) => {
      const result = await api.completeSession(body);
      state.revision = result.revision;
      state.sessionBaseRevision = result.revision;
      await refreshPersistentState();
      return result;
    };
    try { return await send(request); }
    catch (error) {
      if (error.status !== 409) throw error;
      await refreshPersistentState();
      if (state.sessionRevision !== request.sessionRevision || state.workingSession?.id !== request.session?.id) {
        throw new Error("저장된 회차가 다른 작업에서 변경됐습니다. 현재 회차를 다시 읽어 확인하세요.");
      }
      if (!request.beforeInventory) throw error;
      const current = new Map(state.inventory.map((row) => [row.programName, row.stock]));
      const items = {};
      for (const name of Object.keys(request.patch.items)) {
        const stock = current.get(name);
        const before = request.beforeInventory[name];
        if (!Number.isSafeInteger(stock) || !Number.isSafeInteger(before)) throw new Error(`${name}의 재고가 미확인 상태입니다.`);
        const delta = request.inventoryDeltas[name];
        const next = stock + delta;
        if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(next)) throw new Error(`${name}의 재고 계산값이 올바르지 않습니다.`);
        if (next < 0) throw new Error(`${name}의 현재 재고가 완료 차감량보다 부족합니다. 재고를 확인한 뒤 저장을 재시도하세요.`);
        items[name] = { stock: next };
      }
      request.mutationId = createMutationId();
      request.baseRevision = state.revision;
      request.patch = { items };
      return await send(request);
    }
  });
}

window.addEventListener("bdo:session-changed", () => {
  if (window.__bdoPlanGenerating || runtime()?.pending) return;
  sessionEditVersion++;
  state.sessionUnsaved = true;
  const failed = (error) => {
    state.sessionUnsaved = true;
    renderPersistenceRecovery();
    const status = document.getElementById("runtime-status");
    if (status) { status.dataset.kind = "error"; status.textContent = `회차 저장 실패: ${error.message}`; }
  };
  try {
    saveWorkingSession().then((result) => {
      if (!result || state.persistencePending > 0) return;
      const status = document.getElementById("runtime-status");
      if (status) { status.dataset.kind = "success"; status.textContent = "현재 회차 저장을 확인했습니다."; }
    }).catch(failed);
  } catch (error) { failed(error); }
});

export function hasUnresolvedPersistence() {
  return !!state.persistenceIssue || state.sessionUnsaved || api.hasPendingRequest();
}
let recovering = false;
export function renderPersistenceRecovery() {
  const host = document.getElementById('persistence-recovery');
  if (!host) return;
  const parent = hasUnresolvedPersistence()
    ? [...document.querySelectorAll('dialog:modal')].at(-1) || document.body : document.body;
  if (host.parentElement !== parent) {
    if (parent === document.body) parent.append(host);
    else parent.insertBefore(host, parent.querySelector('.dialog-body') || parent.firstChild);
    Object.assign(host.style, parent === document.body
      ? {position: 'fixed', top: '82px', right: '24px', margin: '0', maxWidth: 'min(760px,90vw)'}
      : {position: 'relative', top: 'auto', right: 'auto', margin: '0 20px 12px', maxWidth: 'none'});
  }
  host.hidden = !(state.persistenceIssue || api.hasPendingRequest() || state.sessionUnsaved && state.persistencePending === 0);
  host.querySelector('span').textContent = api.hasPendingRequest()
    ? '저장 결과 확인 필요 · 같은 요청으로 결과를 확인하세요.'
    : state.persistenceIssue
      ? (state.persistenceIssue.committed ? '저장은 확인됐지만 최신 조회가 필요합니다.' : state.persistenceIssue.message)
      : '저장되지 않은 회차 변경이 있습니다.';
  const button = host.querySelector('button');
  button.disabled = recovering || state.persistencePending > 0;
  button.textContent = api.hasPendingRequest() || state.persistenceIssue ? '저장 결과 확인' : '다시 저장';
}
export async function retryPersistence() {
  if (recovering || state.persistencePending > 0) return;
  recovering = true;
  let restoreSession = state.persistenceIssue?.restoreSession ?? api.pendingAffectsSession();
  renderPersistenceRecovery();
  try {
    if (runtime()?.completionPending) { await runtime().retryCompletion(); return; }
    if (api.hasPendingRequest() || state.persistenceIssue) {
      if (api.invalidRecovery()) {
        if (!await confirmAction('복구 기록이 손상되어 같은 저장 요청을 재전송할 수 없습니다. 서버의 최신 저장 상태를 불러와 확인할까요?', {
          title: '복구 기록 확인', acceptLabel: '최신 상태 확인',
        })) return;
        restoreSession = true;
        state.persistenceIssue = {message: '복구 정보가 손상됐습니다. 최신 저장 상태를 확인하세요.', restoreSession};
        api.discardInvalidRecovery();
      }
      if (state.persistenceIssue?.conflict && !await confirmAction(restoreSession
        ? '다른 창에서 저장한 최신 회차로 바꿀까요? 현재 미저장 회차 입력은 교체됩니다.'
        : '다른 창에서 저장한 최신 재고·설정을 불러올까요? 미저장 회차 입력은 유지됩니다.', {
        title: '최신 회차 확인',
      })) return;
      await api.retryPendingRequest();
      await refreshPersistentState({restoreSession});
      state.persistenceIssue = null;
      if (restoreSession) state.sessionUnsaved = false;
      window.__bdoRenderAll?.();
    } else {
      restoreSession = true;
      await saveWorkingSession();
    }
  } catch (error) {
    if (error.status === 409) state.persistenceIssue = {
      message: '다른 창에서 저장 상태가 변경됐습니다. 입력을 유지합니다. 최신 상태를 확인하세요.', conflict: true, restoreSession,
    };
    if (error.committed) state.persistenceIssue = {committed: true, message: error.message, restoreSession};
    window.showToast?.(error.message);
  } finally {
    recovering = false;
    renderPersistenceRecovery();
  }
}
window.__bdoPersistenceBlocked = hasUnresolvedPersistence;
window.__bdoMutationUncertain = () => !!state.persistenceIssue || api.hasPendingRequest();
window.addEventListener('bdo:session-changed', () => queueMicrotask(renderPersistenceRecovery));
document.addEventListener('close', renderPersistenceRecovery, true);
new MutationObserver(renderPersistenceRecovery).observe(document.body, {subtree: true, attributes: true, attributeFilter: ['open']});
