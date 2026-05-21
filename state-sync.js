const LEADS_KEY = "dvWorkshopLeads";
const COUNSELORS_KEY = "dvCounselors";
const ALLOCATION_KEY = "dvCounselorAllocation";

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

export async function bootstrapLocalState() {
  const localLeads = safeParseArray(localStorage.getItem(LEADS_KEY));
  const localCounselors = safeParseArray(localStorage.getItem(COUNSELORS_KEY));
  const localAllocation = safeParseArray(localStorage.getItem(ALLOCATION_KEY));

  try {
    const response = await fetch("/api/state", {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    const serverLeads = Array.isArray(payload.leads) ? payload.leads : [];
    const serverCounselors = Array.isArray(payload.counselors) ? payload.counselors : [];
    const serverAllocation = Array.isArray(payload.allocation) ? payload.allocation : [];

    const mergedLeads = serverLeads.length ? serverLeads : localLeads;
    const mergedCounselors = serverCounselors.length ? serverCounselors : localCounselors;
    const mergedAllocation = serverAllocation.length ? serverAllocation : localAllocation;

    localStorage.setItem(LEADS_KEY, JSON.stringify(mergedLeads));
    localStorage.setItem(COUNSELORS_KEY, JSON.stringify(mergedCounselors));
    localStorage.setItem(ALLOCATION_KEY, JSON.stringify(mergedAllocation));

    const shouldBackfillServer =
      (!serverLeads.length && mergedLeads.length)
      || (!serverCounselors.length && mergedCounselors.length)
      || (!serverAllocation.length && mergedAllocation.length);

    if (shouldBackfillServer) {
      await fetch("/api/state", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          leads: mergedLeads,
          counselors: mergedCounselors,
          allocation: mergedAllocation
        })
      });
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

    await fetch("/api/state", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ leads, counselors, allocation })
    });
  } catch {
    // Best-effort sync; local state remains intact.
  }
}
