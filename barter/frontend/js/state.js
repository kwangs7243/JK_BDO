export const state = {
  revision: null,
  persistenceIssue: null,
  sessionUnsaved: false,
  inventory: [],
  order: {},
  settings: {},
  sessionRevision: null,
  // Metadata refreshes must not advance the version of the editable working copy.
  sessionBaseRevision: null,
  sessionGeneration: 0,
  workingSession: null,
  scheduleSlots: { 1: null, 2: null, 3: null, 4: null, 5: null },
  persistencePending: 0,
  // Ordinary durable refreshes must not replace the current working copy.
  session: { scannedTrades: null, schedule: null, completed: null, remainingParley: null, timers: null, selection: null, drag: null, diagnostics: null },
  mapRouteDraft: []
};

export function applyBootstrap(snapshot) {
  if (!snapshot || !Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.inventory)
      || !snapshot.settings || ['ship', 'parley', 'tuning'].some(key =>
        !snapshot.settings[key] || typeof snapshot.settings[key] !== 'object' || Array.isArray(snapshot.settings[key]))
      || snapshot.inventory.some(item => typeof item?.programName !== 'string'
        || item.stock !== null && (!Number.isSafeInteger(item.stock) || item.stock < 0))) {
    throw new Error('저장 데이터 형식을 확인할 수 없습니다. 기존 화면을 유지합니다.');
  }
  state.revision = snapshot.revision;
  state.inventory = snapshot.inventory;
  state.order = snapshot.order;
  state.settings = snapshot.settings;
  state.sessionRevision = snapshot.sessionRevision ?? null;
  state.workingSession = snapshot.workingSession ?? null;
  state.scheduleSlots = snapshot.scheduleSlots ?? state.scheduleSlots;
  return snapshot;
}
