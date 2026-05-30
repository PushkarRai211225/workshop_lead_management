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
let lastStateETag = null; // tracks the ETag returned by the last GET /api/state
// How long (ms) after a confirmed server write to suppress polling so a stale
// serverless-instance cache cannot revert a lead that was just updated.
const MUTATION_POLL_COOLDOWN_MS = 20000;
// Monotonically increasing counter — incremented each time an optimistic update
// is applied. Used to prevent an older PUT's server response from overwriting
// a newer optimistic state that was applied while the PUT was in flight.
let optimisticSeq = 0;
// How many times to retry a failed PUT before giving up.
const MAX_PUT_RETRIES = 3;
// Timeout for state mutation PUT requests. Longer than the read timeout to
// accommodate high-latency connections and larger JSON bodies.
const PUT_TIMEOUT_MS = 20000;
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
    marketingUsers: Array.isArray(snapshot?.marketingUsers) ? snapshot.marketingUsers : [],
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
  const headers = { Accept: "application/json" };
  // Send the ETag from the previous response so the server can return 304 when
  // the state has not changed, saving the full payload transfer on every poll.
  if (lastStateETag) {
    headers["If-None-Match"] = lastStateETag;
  }

  const { response, payload } = await fetchJson("/api/state", {
    method: "GET",
    headers
  });

  // 304 Not Modified — state unchanged, keep what we have.
  if (response.status === 304) {
    lastStateRefreshAt = Date.now();
    return getStateSnapshot();
  }

  if (!response.ok) {
    throw new Error(payload?.message || "Failed to fetch state.");
  }

  // Capture the new ETag for the next conditional request.
  const etag = response.headers.get("etag");
  if (etag) lastStateETag = etag;

  return setCurrentState(payload);
}

export async function updateStateFields(fields) {
  const nextFields = Object.fromEntries(
    Object.entries(fields || {}).filter(([, value]) => Array.isArray(value))
  );

  if (!Object.keys(nextFields).length) {
    return { ok: false, message: "No valid state fields provided." };
  }

  // Stamp this optimistic update with a monotonically increasing sequence number.
  // When the PUT response eventually arrives we only apply setCurrentState if no
  // newer optimistic update has been applied in the meantime — this prevents PUT#1's
  // response from overwriting a note/task that was applied optimistically while PUT#1
  // was still in flight.
  const mySeq = ++optimisticSeq;

  // Apply optimistically so subsequent reads and subscribers see the change immediately,
  // without waiting for the server round-trip. This eliminates the delay between a
  // counselor saving an activity and the table reflecting the update.
  setCurrentState({ ...currentState, ...nextFields });

  pendingStateUpdate = pendingStateUpdate.then(async () => {
    // Retry the PUT up to MAX_PUT_RETRIES times on transient network failures before
    // reverting optimistic state. On high-latency connections (>300 ms) transient
    // failures are common and a single attempt is not sufficient.
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_PUT_RETRIES; attempt++) {
      try {
        // keepalive: true ensures the browser sends this request to completion
        // even if the user navigates away or reloads the page before the response
        // arrives. Without this, page navigation mid-write silently drops the PUT.
        // Browsers reject keepalive requests whose body exceeds 64 KB — check the
        // serialised size directly instead of relying on new Request() which does
        // NOT throw synchronously for oversized bodies in Chrome/Edge.
        const body = JSON.stringify(nextFields);
        const useKeepalive = body.length < 60 * 1024; // conservative threshold below 64 KB
        const fetchOptions = {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(lastStateETag ? { "If-Match": lastStateETag } : {})
          },
          body,
          ...(useKeepalive ? { keepalive: true } : {})
        };
        const { response, payload } = await fetchJson("/api/state", fetchOptions, PUT_TIMEOUT_MS);

        if (response.ok) {
          const etag = response.headers.get("etag");
          if (etag) {
            lastStateETag = etag;
          }
          // Only replace in-memory state with the server response if no newer
          // optimistic update has been applied after this one. If a newer update
          // is already in memory we must not overwrite it with an older snapshot.
          if (optimisticSeq === mySeq) {
            setCurrentState(payload);
          }
          // Record the time of this confirmed server write so the polling loop can
          // skip refreshState() during the cooldown window. This prevents a stale
          // in-memory cache on another Vercel serverless instance from overwriting
          // the update we just confirmed was persisted to MongoDB.
          lastSuccessfulMutationAt = Date.now();
          return { ok: true, payload: getStateSnapshot() };
        }

        // 4xx errors are definitive failures — do not retry.
        if (response.status >= 400 && response.status < 500) {
          void refreshState().catch(() => undefined);
          return { ok: false, message: payload?.message || "Failed to update state." };
        }

        // 5xx — server-side error, retry after backoff.
        lastError = new Error(payload?.message || `Server error ${response.status}`);
      } catch (err) {
        // Network failure (timeout, abort, DNS, etc.) — retry.
        lastError = err;
      }

      if (attempt < MAX_PUT_RETRIES) {
        // Exponential backoff: 2 s, 4 s between retries.
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }

    // All retries exhausted — revert to the authoritative server state so the UI
    // reflects what is actually persisted rather than showing an optimistic lie.
    void refreshState().catch(() => undefined);
    return { ok: false, message: lastError?.message || "Failed to update state after retries." };
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

/**
 * Wait for all queued mutations to complete, then read back from the server
 * to confirm durable persistence.  Waits for the mutation poll-cooldown window
 * to expire first so we don't accidentally hit a stale serverless-instance
 * cache and mistake old data for the freshly written state.
 */
export async function syncStateFromLocalAndVerify() {
  try {
    await pendingStateUpdate;

    // If a mutation was confirmed recently, wait for the server-side cache TTL
    // (5 s) to expire before reading back.  This ensures the GET hits MongoDB
    // directly rather than a stale in-memory cache on a different serverless
    // instance that hasn't seen the write yet.
    const msSinceMutation = Date.now() - lastSuccessfulMutationAt;
    const SERVER_CACHE_TTL_MS = 5000;
    if (lastSuccessfulMutationAt > 0 && msSinceMutation < SERVER_CACHE_TTL_MS) {
      await new Promise((resolve) => setTimeout(resolve, SERVER_CACHE_TTL_MS - msSinceMutation + 200));
    }

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

/**
 * Resolves once all currently-queued state mutation PUTs have settled.
 * Use this in navigation handlers to prevent a soft-nav refreshState() from
 * overwriting optimistic state that is still being written to the server.
 */
export async function awaitPendingMutations() {
  return pendingStateUpdate;
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

export function getMarketingUsers() {
  return getStateField("marketingUsers");
}

export async function saveMarketingUsers(marketingUsers) {
  return updateStateFields({ marketingUsers });
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
