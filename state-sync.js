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
      return { ok: false, message: payload?.message || "Failed to update state." };
    }

    setCurrentState(payload);
    return { ok: true, payload: getStateSnapshot() };
  }).catch((error) => ({
    ok: false,
    message: error?.message || "Failed to update state."
  }));

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
      await Promise.all([
        refreshState(),
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

export function startStatePolling(onRefresh, intervalMs = 5000) {
  let isDisposed = false;

  const runRefresh = () => {
    if (isDisposed || document.hidden) {
      return;
    }

    void refreshState().then(() => {
      if (typeof onRefresh === "function") {
        onRefresh(getStateSnapshot());
      }
    }).catch(() => {
      // Keep the last rendered snapshot when the API is temporarily unavailable.
    });
  };

  const intervalId = setInterval(runRefresh, intervalMs);

  const handleVisibilityChange = () => {
    if (!document.hidden) {
      runRefresh();
    }
  };

  const handlePageShow = () => {
    runRefresh();
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pageshow", handlePageShow);

  return () => {
    isDisposed = true;
    clearInterval(intervalId);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pageshow", handlePageShow);
  };
}
