const LEADS_KEY = "dvWorkshopLeads";
const COUNSELORS_KEY = "dvCounselors";
const ALLOCATION_KEY = "dvCounselorAllocation";
const TASKS_KEY = "dvWorkshopTasks";
const STATE_SYNCED_AT_KEY = "dvWorkshopStateSyncedAt";
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

function getLastBootstrapAt() {
  const value = Number(localStorage.getItem(BOOTSTRAP_SYNCED_AT_KEY) || 0);
  return Number.isFinite(value) ? value : 0;
}

function markBootstrapSynced() {
  localStorage.setItem(BOOTSTRAP_SYNCED_AT_KEY, String(Date.now()));
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
      void (async () => {
        try {
          const response = await fetchWithTimeout("/api/state", {
            method: "GET",
            headers: {
              Accept: "application/json"
            }
          }, 4000);

          if (!response.ok) {
            return;
          }

          const payload = await response.json();
          const serverLeads = Array.isArray(payload.leads) ? payload.leads : [];
          const serverCounselors = Array.isArray(payload.counselors) ? payload.counselors : [];
          const serverAllocation = Array.isArray(payload.allocation) ? payload.allocation : [];
          const serverTasks = Array.isArray(payload.tasks) ? payload.tasks : [];

          const serverLooksFresh =
            !serverLeads.length
            && !serverCounselors.length
            && !serverAllocation.length
            && !serverTasks.length;

          const mergedLeads = serverLooksFresh && localSnapshot.leads.length ? localSnapshot.leads : serverLeads;
          const mergedCounselors = serverLooksFresh && localSnapshot.counselors.length ? localSnapshot.counselors : serverCounselors;
          const mergedAllocation = serverLooksFresh && localSnapshot.allocation.length ? localSnapshot.allocation : serverAllocation;
          const mergedTasks = serverTasks.length ? serverTasks : localSnapshot.tasks;

          writeStateSnapshot({
            leads: mergedLeads,
            counselors: mergedCounselors,
            allocation: mergedAllocation,
            tasks: mergedTasks
          });
          markBootstrapSynced();
        } catch {
          // Keep local cache when API is temporarily unavailable.
        }
      })();
    }

    return;
  }

  try {
    const response = await fetchWithTimeout("/api/state", {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    }, 4000);

    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    const serverLeads = Array.isArray(payload.leads) ? payload.leads : [];
    const serverCounselors = Array.isArray(payload.counselors) ? payload.counselors : [];
    const serverAllocation = Array.isArray(payload.allocation) ? payload.allocation : [];
    const serverTasks = Array.isArray(payload.tasks) ? payload.tasks : [];

    const serverLooksFresh =
      !serverLeads.length
      && !serverCounselors.length
      && !serverAllocation.length
      && !serverTasks.length;

    // Prefer server state whenever it exists, even when arrays are empty.
    // Only fall back to local cache when the server is completely fresh.
    const mergedLeads = serverLooksFresh && localSnapshot.leads.length ? localSnapshot.leads : serverLeads;
    const mergedCounselors = serverLooksFresh && localSnapshot.counselors.length ? localSnapshot.counselors : serverCounselors;
    const mergedAllocation = serverLooksFresh && localSnapshot.allocation.length ? localSnapshot.allocation : serverAllocation;
    const mergedTasks = serverTasks.length ? serverTasks : localSnapshot.tasks;

    writeStateSnapshot({
      leads: mergedLeads,
      counselors: mergedCounselors,
      allocation: mergedAllocation,
      tasks: mergedTasks
    });
    markBootstrapSynced();

    const shouldBackfillServer = (serverLooksFresh || (!serverTasks.length && localSnapshot.tasks.length)) && (
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
