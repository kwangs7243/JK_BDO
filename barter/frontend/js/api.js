import { requestJSON } from '/portal-assets/http.js';

const jsonRequest = (path, {method = 'GET', body} = {}) => requestJSON(path, {
  method, headers: body === undefined ? {} : {'Content-Type': 'application/json'},
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = Object.freeze({
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
