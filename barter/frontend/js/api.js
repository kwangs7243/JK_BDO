import { requestJSON } from '/portal-assets/http.js';

const recoveryKey = 'bdo-pending-write-v1';
let pendingRequest = null;
let invalidRecovery = false;
try {
  const raw = sessionStorage.getItem(recoveryKey);
  if (raw !== null) {
    invalidRecovery = true;
    const saved = JSON.parse(raw), body = JSON.parse(saved.body);
    if (saved && typeof saved.path === 'string'
        && /^\/api\/(inventory(?:\/order)?|settings|working-session(?:\/completion)?|schedule-slots\/[1-5])$/.test(saved.path)
        && typeof body?.mutationId === 'string' && Number.isSafeInteger(body.baseRevision)
        && ['PUT', 'POST', 'PATCH', 'DELETE'].includes(saved.method)) {
      pendingRequest = saved;
      invalidRecovery = false;
    }
  }
} catch { /* Keep corrupt records visible; storage-disabled browsers retain recovery in memory. */ }

function remember(value) {
  pendingRequest = value;
  try {
    if (value) sessionStorage.setItem(recoveryKey, JSON.stringify(value));
    else sessionStorage.removeItem(recoveryKey);
  } catch { /* The in-memory request remains retryable when browser storage is unavailable. */ }
}

const jsonRequest = async (path, {method = 'GET', body} = {}) => {
  const text = body === undefined ? undefined : JSON.stringify(body);
  if (method !== 'GET' && pendingRequest && (pendingRequest.path !== path || pendingRequest.body !== text)) {
    const error = new Error('앞선 저장 결과를 먼저 확인하세요.');
    error.uncertain = true;
    throw error;
  }
  try {
    const result = await requestJSON(path, {
      method, headers: text === undefined ? {} : {'Content-Type': 'application/json'}, body: text,
    });
    if (body?.mutationId && !Number.isSafeInteger(result.revision)) {
      const error = new Error('저장 응답의 버전이 올바르지 않습니다. 결과를 확인하세요.');
      error.uncertain = true;
      throw error;
    }
    if (pendingRequest?.path === path && pendingRequest.body === text) remember(null);
    return result;
  } catch (error) {
    if (error.uncertain && body?.mutationId) remember({path, method, body: text});
    else if ([400, 409, 422].includes(error.status) && pendingRequest?.path === path && pendingRequest.body === text) remember(null);
    throw error;
  }
};

export const api = Object.freeze({
  hasPendingRequest: () => !!pendingRequest || invalidRecovery,
  pendingAffectsSession: () => pendingRequest?.path.startsWith("/api/working-session") === true,
  invalidRecovery: () => invalidRecovery,
  discardInvalidRecovery: () => { invalidRecovery = false; remember(null); },
  retryPendingRequest: async () => {
    if (!pendingRequest) return;
    const saved = pendingRequest;
    return jsonRequest(saved.path, {method: saved.method, body: JSON.parse(saved.body)});
  },
  health: () => jsonRequest("/api/health"),
  bootstrap: () => jsonRequest("/api/bootstrap"),
  saveWorkingSession: (body) => jsonRequest("/api/working-session", { method: "PUT", body }),
  resetWorkingSession: (body) => jsonRequest("/api/working-session", { method: "DELETE", body }),
  saveScheduleSlot: (slot, body) => jsonRequest(`/api/schedule-slots/${slot}`, { method: "PUT", body }),
  deleteScheduleSlot: (slot, body) => jsonRequest(`/api/schedule-slots/${slot}`, { method: "DELETE", body }),
  completeSession: (body) => jsonRequest("/api/working-session/completion", { method: "POST", body }),
  inventory: () => jsonRequest("/api/inventory"),
  patchInventory: (payload) => jsonRequest("/api/inventory", { method: "PATCH", body: payload }),
  warehouseScan: async (capture) => {
    const blob = capture?.blob instanceof Blob ? capture.blob : capture;
    const form = new FormData();
    form.append("image", blob, capture?.blob ? "capture.png" : (blob?.name || "capture.png"));
    return requestJSON('/api/warehouse-scan', {method: 'POST', body: form});
  },
  inventoryOrder: () => jsonRequest("/api/inventory/order"),
  saveInventoryOrder: (payload) => jsonRequest("/api/inventory/order", { method: "PUT", body: payload }),
  settings: () => jsonRequest("/api/settings"),
  patchSettings: (payload) => jsonRequest("/api/settings", { method: "PATCH", body: payload }),
});
