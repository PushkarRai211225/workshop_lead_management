const EMPTY_STATE = {
  leads: [],
  counselors: [],
  allocation: [],
  tasks: []
};

let currentState = cloneValue(EMPTY_STATE);
let currentSession = null;
let bootstrapPromise = null;
let pendingStateUpdate = Promise.resolve();
const preferenceCache = new Map();
let lastStateRefreshAt = 0;
let lastSuccessfulMutationAt = 0;
// How long (ms) after a confirmed server write to suppress polling so a stale
// serverless-instance cache cannot revert a lead that was just updated.
const MUTATION_POLL_COOLDOWN_MS = 20000;
const stateSubscribers = new Set();

function notifyStateSubscribers() {
  const snapshot = getStateSnapshot();

  stateSubscribers.forEach((subscriber) => {
    try {
      subscriber(snapshot);
    } catch (error) {
      console.error("Failed to notify a state subscriber.", error);
    }
  });
}

function cloneValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function normalizeState(snapshot = {}) {
  return {
    leads: Array.isArray(snapshot?.leads) ? snapshot.leads : [],
    counselors: Array.isArray(snapshot?.counselors) ? snapshot.counselors : [],
    allocation: Array.isArray(snapshot?.allocation) ? snapshot.allocation : [],
    tasks: Array.isArray(snapshot?.tasks) ? snapshot.tasks : []
  };
}

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    ...options,
    credentials: "same-origin",
    signal: controller.signal
  }).finally(() => clearTimeout(timeoutId));
}

async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await response.json() : null;
  return { response, payload };
}

function setCurrentState(snapshot) {
  currentState = normalizeState(snapshot);
  lastStateRefreshAt = Date.now();
  notifyStateSubscribers();
  return getStateSnapshot();
}

export function getStateSnapshot() {
  return cloneValue(currentState);
}

export function getStateField(field) {
  return cloneValue(currentState?.[field] ?? []);
}

export function getLeads() {
  return getStateField("leads");
}

export function getCounselors() {
  return getStateField("counselors");
}

export function getAllocation() {
  return getStateField("allocation");
}

export function getTasks() {
  return getStateField("tasks");
}

export function replaceStateSnapshot(snapshot) {
  return setCurrentState(snapshot);
}

export async function refreshState() {
  const { response, payload } = await fetchJson("/api/state", {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(payload?.message || "Failed to fetch state.");
  }

  return setCurrentState(payload);
}

export async function updateStateFields(fields) {
  const nextFields = Object.fromEntries(
    Object.entries(fields || {}).filter(([, value]) => Array.isArray(value))
  );

  if (!Object.keys(nextFields).length) {
    return { ok: false, message: "No valid state fields provided." };
  }

  // Apply optimistically so subsequent reads and subscribers see the change immediately,
  // without waiting for the server round-trip. This eliminates the delay between a
  // counselor saving an activity and the table reflecting the update.
  setCurrentState({ ...currentState, ...nextFields });

  pendingStateUpdate = pendingStateUpdate.then(async () => {
    const { response, payload } = await fetchJson("/api/state", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(nextFields)
    });

    if (!response.ok) {
      // Correct any wrong optimistic state by fetching the authoritative server state.
      void refreshState().catch(() => undefined);
      return { ok: false, message: payload?.message || "Failed to update state." };
    }

    setCurrentState(payload);
    // Record the time of this confirmed server write so the polling loop can
    // skip refreshState() during the cooldown window.  This prevents a stale
    // in-memory cache on another Vercel serverless instance from overwriting
    // the update we just confirmed was persisted to MongoDB.
    lastSuccessfulMutationAt = Date.now();
    return { ok: true, payload: getStateSnapshot() };
  }).catch((error) => {
    // On network failure refresh to restore correct server state.
    void refreshState().catch(() => undefined);
    return { ok: false, message: error?.message || "Failed to update state." };
  });

  return pendingStateUpdate;
}

export async function syncStateFromLocal() {
  return { ok: true, scheduled: false };
}

export async function syncStateFromLocalAndVerify() {
  try {
    await pendingStateUpdate;
    await refreshState();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || "Unable to confirm the backend update."
    };
  }
}

export function markStateMutated() {
  return undefined;
}

export async function refreshSession() {
  const { response, payload } = await fetchJson("/api/auth/session", {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  if (response.status === 401) {
    currentSession = null;
    return null;
  }

  if (!response.ok) {
    throw new Error(payload?.message || "Failed to fetch session.");
  }

  currentSession = payload;
  return getSession();
}

export function getSession() {
  return currentSession ? cloneValue(currentSession) : null;
}

export async function login({ role, identifier, password }) {
  const { response, payload } = await fetchJson("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ role, identifier, password })
  });

  if (!response.ok) {
    return {
      ok: false,
      message: payload?.message || "Login failed."
    };
  }

  currentSession = payload?.session || null;
  return {
    ok: true,
    session: getSession(),
    landing: payload?.landing || "index.html"
  };
}

export async function logout() {
  await fetchWithTimeout("/api/auth/logout", {
    method: "POST",
    headers: {
      Accept: "application/json"
    }
  });

  currentSession = null;
  preferenceCache.clear();
}

export async function bootstrapLocalState() {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const shouldRefreshState = !lastStateRefreshAt || (Date.now() - lastStateRefreshAt) > 1500;

      await Promise.all([
        shouldRefreshState ? refreshState() : Promise.resolve(getStateSnapshot()),
        refreshSession().catch(() => null)
      ]);
    })().finally(() => {
      bootstrapPromise = null;
    });
  }

  return bootstrapPromise;
}

export async function loadPersistedValue(key, fallback) {
  const scope = encodeURIComponent(String(key || "").trim());
  if (!scope) {
    return cloneValue(fallback);
  }

  if (preferenceCache.has(scope)) {
    return cloneValue(preferenceCache.get(scope));
  }

  const { response, payload } = await fetchJson(`/api/preferences/${scope}`, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    return cloneValue(fallback);
  }

  const value = payload?.value ?? cloneValue(fallback);
  preferenceCache.set(scope, cloneValue(value));
  return cloneValue(value);
}

export async function savePersistedValue(key, value) {
  const scope = encodeURIComponent(String(key || "").trim());
  if (!scope) {
    return { ok: false, message: "Preference scope is required." };
  }

  preferenceCache.set(scope, cloneValue(value));

  const { response, payload } = await fetchJson(`/api/preferences/${scope}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ value })
  });

  if (!response.ok) {
    return { ok: false, message: payload?.message || "Failed to save preference." };
  }

  return { ok: true, value: payload?.value ?? value };
}

export async function saveLeads(leads) {
  return updateStateFields({ leads });
}

export async function saveCounselors(counselors) {
  return updateStateFields({ counselors });
}

export async function saveAllocation(allocation) {
  return updateStateFields({ allocation });
}

export async function saveTasks(tasks) {
  return updateStateFields({ tasks });
}

export function startStatePolling(onRefresh, intervalMs = 15000) {
  if (typeof onRefresh !== "function") {
    return () => undefined;
  }

  stateSubscribers.add(onRefresh);

  let pollTimer = null;
  let activePoll = false;
  let destroyed = false;

  async function doPoll() {
    if (destroyed || activePoll) {
      return;
    }
    activePoll = true;
    try {
      // Capture the current pending-update promise so we can detect if new mutations
      // are queued while we are waiting.
      const pendingAtStart = pendingStateUpdate;
      await pendingAtStart;

      // If more mutations were queued while we were waiting, skip this poll cycle.
      // A stale GET response must not overwrite writes that are still in flight.
      if (pendingStateUpdate !== pendingAtStart) {
        return;
      }

      // If a mutation was confirmed recently, skip this poll.  On Vercel the
      // serverless function that handles GET /api/state may be a different
      // instance from the one that processed the PUT, and its in-memory cache
      // can still hold the pre-update state for up to SERVER_CACHE_TTL (10 s).
      // Suppressing polls for MUTATION_POLL_COOLDOWN_MS (20 s) ensures we
      // never hand a stale cache response back to the client and undo a lead
      // activity update that was already confirmed by the server.
      if (Date.now() - lastSuccessfulMutationAt < MUTATION_POLL_COOLDOWN_MS) {
        return;
      }

      await refreshState();
    } catch (_e) {
      // Ignore transient network errors — the next poll or navigation will recover.
    } finally {
      activePoll = false;
    }
  }

  function schedulePoll() {
    if (destroyed) {
      return;
    }
    pollTimer = setTimeout(() => {
      if (document.visibilityState !== "hidden") {
        void doPoll();
      }
      schedulePoll();
    }, intervalMs);
  }

  function handleVisibilityChange() {
    if (destroyed || document.visibilityState !== "visible") {
      return;
    }
    // Immediately refresh when the user tabs back so they always see current data.
    clearTimeout(pollTimer);
    doPoll().finally(() => {
      if (!destroyed) {
        schedulePoll();
      }
    });
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  schedulePoll();

  return () => {
    destroyed = true;
    stateSubscribers.delete(onRefresh);
    clearTimeout(pollTimer);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  };
}
