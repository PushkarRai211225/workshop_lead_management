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
    localStorage.setItem(LEADS_KEY, JSON.stringify(Array.isArray(payload.leads) ? payload.leads : []));
    localStorage.setItem(
      COUNSELORS_KEY,
      JSON.stringify(Array.isArray(payload.counselors) ? payload.counselors : [])
    );
    localStorage.setItem(
      ALLOCATION_KEY,
      JSON.stringify(Array.isArray(payload.allocation) ? payload.allocation : [])
    );
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
