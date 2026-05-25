const LEADS_KEY = "dvWorkshopLeads";
const COUNSELORS_KEY = "dvCounselors";
const ALLOCATION_KEY = "dvCounselorAllocation";
const TASKS_KEY = "dvWorkshopTasks";
const STATE_SYNCED_AT_KEY = "dvWorkshopStateSyncedAt";
const STATE_MUTATED_AT_KEY = "dvWorkshopStateMutatedAt";
const BOOTSTRAP_SYNCED_AT_KEY = "dvWorkshopBootstrapSyncedAt";
const BOOTSTRAP_TTL_MS = 60000;

let syncInFlight = null;
let syncQueued = false;

function readArrayFromStorage(key) {
  const value = localStorage.getItem(key);
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readStateSnapshot() {
  return {
    leads: readArrayFromStorage(LEADS_KEY),
    counselors: readArrayFromStorage(COUNSELORS_KEY),
    allocation: readArrayFromStorage(ALLOCATION_KEY),
    tasks: readArrayFromStorage(TASKS_KEY)
  };
}

function writeStateSnapshot(snapshot) {
  localStorage.setItem(LEADS_KEY, JSON.stringify(Array.isArray(snapshot.leads) ? snapshot.leads : []));
  localStorage.setItem(COUNSELORS_KEY, JSON.stringify(Array.isArray(snapshot.counselors) ? snapshot.counselors : []));
  localStorage.setItem(ALLOCATION_KEY, JSON.stringify(Array.isArray(snapshot.allocation) ? snapshot.allocation : []));
  localStorage.setItem(TASKS_KEY, JSON.stringify(Array.isArray(snapshot.tasks) ? snapshot.tasks : []));
}

export function replaceStateSnapshot(snapshot) {
  writeStateSnapshot(snapshot);
}

function normalizeSnapshot(snapshot) {
  return {
    leads: Array.isArray(snapshot?.leads) ? snapshot.leads : [],
    counselors: Array.isArray(snapshot?.counselors) ? snapshot.counselors : [],
    allocation: Array.isArray(snapshot?.allocation) ? snapshot.allocation : [],
    tasks: Array.isArray(snapshot?.tasks) ? snapshot.tasks : []
  };
}

function snapshotsMatch(left, right) {
  const normalizedLeft = normalizeSnapshot(left);
  const normalizedRight = normalizeSnapshot(right);
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function hasAnyState(snapshot) {
  return Boolean(
    (Array.isArray(snapshot.leads) && snapshot.leads.length)
    || (Array.isArray(snapshot.counselors) && snapshot.counselors.length)
    || (Array.isArray(snapshot.allocation) && snapshot.allocation.length)
    || (Array.isArray(snapshot.tasks) && snapshot.tasks.length)
  );
}

function markStateSynced() {
  localStorage.setItem(STATE_SYNCED_AT_KEY, String(Date.now()));
}

function getLastStateMutatedAt() {
  const value = Number(localStorage.getItem(STATE_MUTATED_AT_KEY) || 0);
  return Number.isFinite(value) ? value : 0;
}

export function markStateMutated() {
  localStorage.setItem(STATE_MUTATED_AT_KEY, String(Date.now()));
}

function getLastBootstrapAt() {
  const value = Number(localStorage.getItem(BOOTSTRAP_SYNCED_AT_KEY) || 0);
  return Number.isFinite(value) ? value : 0;
}

function markBootstrapSynced() {
  localStorage.setItem(BOOTSTRAP_SYNCED_AT_KEY, String(Date.now()));
}

async function fetchServerState(timeoutMs = 4000) {
  const response = await fetchWithTimeout("/api/state", {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  }, timeoutMs);

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  const snapshot = normalizeSnapshot(payload);

  return {
    payload,
    snapshot,
    updatedAt: Number(new Date(payload.updatedAt || 0).getTime()) || 0,
    clearedAt: Number(new Date(payload.clearedAt || 0).getTime()) || 0
  };
}

async function refreshBootstrapState(localSnapshot, allowBackfill = false) {
  const serverState = await fetchServerState();
  if (!serverState) {
    return;
  }

  const serverLeads = serverState.snapshot.leads;
  const serverCounselors = serverState.snapshot.counselors;
  const serverAllocation = serverState.snapshot.allocation;
  const serverTasks = serverState.snapshot.tasks;
  const lastLocalMutationAt = getLastStateMutatedAt();

  const serverLooksFresh =
    !serverLeads.length
    && !serverCounselors.length
    && !serverAllocation.length
    && !serverTasks.length;

  const preferLocalSnapshot = !serverState.clearedAt && (
    serverLooksFresh || (lastLocalMutationAt && lastLocalMutationAt >= serverState.updatedAt)
  );

  const mergedLeads = preferLocalSnapshot && localSnapshot.leads.length ? localSnapshot.leads : serverLeads;
  const mergedCounselors = preferLocalSnapshot && localSnapshot.counselors.length ? localSnapshot.counselors : serverCounselors;
  const mergedAllocation = preferLocalSnapshot && localSnapshot.allocation.length ? localSnapshot.allocation : serverAllocation;
  const mergedTasks = preferLocalSnapshot && localSnapshot.tasks.length ? localSnapshot.tasks : serverTasks;

  writeStateSnapshot({
    leads: mergedLeads,
    counselors: mergedCounselors,
    allocation: mergedAllocation,
    tasks: mergedTasks
  });
  markBootstrapSynced();

  const shouldBackfillServer = allowBackfill && (serverLooksFresh || (!serverTasks.length && localSnapshot.tasks.length)) && (
    mergedLeads.length
    || mergedCounselors.length
    || mergedAllocation.length
    || mergedTasks.length
  );

  if (shouldBackfillServer) {
    void fetchWithTimeout("/api/state", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        leads: mergedLeads,
        counselors: mergedCounselors,
        allocation: mergedAllocation,
        tasks: mergedTasks
      })
    }, 4000);
  }
}

function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    ...options,
    signal: controller.signal
  }).finally(() => clearTimeout(timeoutId));
}

function safeParseArray(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function loadPersistedValue(key, fallback) {
  const parsed = safeParseValue(localStorage.getItem(key));
  return parsed === null ? structuredClone(fallback) : parsed;
}

export function savePersistedValue(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export async function bootstrapLocalState() {
  const localSnapshot = readStateSnapshot();
  const localHasState = hasAnyState(localSnapshot);
  const lastBootstrapAt = getLastBootstrapAt();

  if (localHasState) {
    if (Date.now() - lastBootstrapAt >= BOOTSTRAP_TTL_MS) {
      try {
        await refreshBootstrapState(localSnapshot, false);
      } catch {
        // Keep local cache when API is temporarily unavailable.
      }
    }

    return;
  }

  try {
    await refreshBootstrapState(localSnapshot, true);
  } catch {
    // Keep local cache when API is temporarily unavailable.
  }
}

async function flushStateSync() {
  if (syncInFlight) {
    syncQueued = true;
    return syncInFlight;
  }

  syncInFlight = (async () => {
    do {
      syncQueued = false;
      const snapshot = readStateSnapshot();

      const response = await fetchWithTimeout("/api/state", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(snapshot)
      }, 4000);

      if (response.ok) {
        markStateSynced();
      }
    } while (syncQueued);
  })().catch(() => {
    // Best-effort sync; local state remains intact.
  }).finally(() => {
    syncInFlight = null;
  });

  return syncInFlight;
}

export async function syncStateFromLocal() {
  try {
    void flushStateSync();
    return { ok: true, scheduled: true };
  } catch {
    // Best-effort sync; local state remains intact.
    return { ok: false };
  }
}

export async function syncStateFromLocalAndVerify(timeoutMs = 4000) {
  const localSnapshot = readStateSnapshot();

  try {
    await flushStateSync();

    const response = await fetchWithTimeout("/api/state", {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    }, timeoutMs);

    if (!response.ok) {
      return { ok: false, message: "Backend verification failed." };
    }

    const payload = await response.json();
    const verifiedSnapshot = normalizeSnapshot(payload);

    if (!snapshotsMatch(localSnapshot, verifiedSnapshot)) {
      return { ok: false, message: "Backend state does not match the saved changes." };
    }

    markStateSynced();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || "Unable to confirm the backend update."
    };
  }
}
