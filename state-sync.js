const LEADS_KEY = "dvWorkshopLeads";
const COUNSELORS_KEY = "dvCounselors";
const ALLOCATION_KEY = "dvCounselorAllocation";
const TASKS_KEY = "dvWorkshopTasks";

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
  const localLeads = safeParseArray(localStorage.getItem(LEADS_KEY));
  const localCounselors = safeParseArray(localStorage.getItem(COUNSELORS_KEY));
  const localAllocation = safeParseArray(localStorage.getItem(ALLOCATION_KEY));
  const localTasks = safeParseArray(localStorage.getItem(TASKS_KEY));

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
    const mergedLeads = serverLooksFresh && localLeads.length ? localLeads : serverLeads;
    const mergedCounselors = serverLooksFresh && localCounselors.length ? localCounselors : serverCounselors;
    const mergedAllocation = serverLooksFresh && localAllocation.length ? localAllocation : serverAllocation;
    const mergedTasks = serverTasks.length ? serverTasks : localTasks;

    localStorage.setItem(LEADS_KEY, JSON.stringify(mergedLeads));
    localStorage.setItem(COUNSELORS_KEY, JSON.stringify(mergedCounselors));
    localStorage.setItem(ALLOCATION_KEY, JSON.stringify(mergedAllocation));
    localStorage.setItem(TASKS_KEY, JSON.stringify(mergedTasks));

    const shouldBackfillServer = (serverLooksFresh || (!serverTasks.length && localTasks.length)) && (
      mergedLeads.length
      || mergedCounselors.length
      || mergedAllocation.length
      || mergedTasks.length
    );

    if (shouldBackfillServer) {
      await fetchWithTimeout("/api/state", {
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

export async function syncStateFromLocal() {
  try {
    const leads = safeParseArray(localStorage.getItem(LEADS_KEY));
    const counselors = safeParseArray(localStorage.getItem(COUNSELORS_KEY));
    const allocation = safeParseArray(localStorage.getItem(ALLOCATION_KEY));
    const tasks = safeParseArray(localStorage.getItem(TASKS_KEY));

    const response = await fetchWithTimeout("/api/state", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ leads, counselors, allocation, tasks })
    }, 4000);

    return { ok: response.ok };
  } catch {
    // Best-effort sync; local state remains intact.
    return { ok: false };
  }
}
