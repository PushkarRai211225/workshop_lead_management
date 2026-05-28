import { registerPageCleanup } from "./page-runtime.js";
import { bootstrapLocalState, getCounselors, getLeads as getStoredLeads, getSession, loadPersistedValue, saveLeads as persistLeads, savePersistedValue, startStatePolling } from "./state-sync.js";

await bootstrapLocalState();

const lostKpiSection = document.getElementById("lostKpiSection");
const lostLeadTableSection = document.getElementById("lostLeadTableSection");
const lostSearchInput = document.getElementById("lostSearchInput");
const resetLostSearch = document.getElementById("resetLostSearch");

const session = getSession();
const SEARCH_STORAGE_KEY = "dvWorkshopLostLeadSearch";

let searchQuery = String(await loadPersistedValue(SEARCH_STORAGE_KEY, "") || "");

if (lostSearchInput) {
  lostSearchInput.value = searchQuery;
}

function isCounselorSession() {
  return session?.role === "counselor";
}

function getCounselorIdentity() {
  if (!isCounselorSession()) {
    return "";
  }

  const sessionName = String(session?.name || "").trim().toLowerCase();
  const sessionEmail = String(session?.email || "").trim().toLowerCase();
  const counselors = getCounselors();
  const match = counselors.find(
    (item) => String(item.email || "").trim().toLowerCase() === sessionEmail
  );

  return String(match?.name || session?.name || "").trim().toLowerCase() || sessionName;
}

function persistSearchQuery() {
  void savePersistedValue(SEARCH_STORAGE_KEY, searchQuery);
}

function getScopedLeads(allLeads) {
  if (!isCounselorSession()) {
    return allLeads;
  }

  const counselorName = getCounselorIdentity();
  if (!counselorName) {
    return [];
  }

  return allLeads.filter(
    (lead) => String(lead.counselor || "").trim().toLowerCase() === counselorName
  );
}

function normalizeLeadFields(leads) {
  leads.forEach((lead) => {
    lead.name = lead.name || "";
    lead.email = (lead.email || "").toLowerCase();
    lead.workshop = lead.workshop || "";
    lead.createdAt = lead.createdAt || new Date().toISOString().slice(0, 10);

    lead.dialed = lead.dialed || "";
    lead.callStatus = lead.callStatus || "";
    lead.wsStatus = lead.wsStatus || "";
    lead.whatsappInvite = lead.whatsappInvite || "";
    lead.counselor = lead.counselor || "Unassigned";

    lead.postDialed = lead.postDialed || "";
    lead.coursePitched = lead.coursePitched || "";
    lead.courseStatus = lead.courseStatus || "";
    lead.admissionStatus = lead.admissionStatus || "";
    lead.postStatusUpdated = typeof lead.postStatusUpdated === "boolean" ? lead.postStatusUpdated : false;
    lead.workshopActivityHistory = Array.isArray(lead.workshopActivityHistory) ? lead.workshopActivityHistory : [];
    lead.admissionActivityHistory = Array.isArray(lead.admissionActivityHistory) ? lead.admissionActivityHistory : [];
    lead.preActivityUpdates = lead.workshopActivityHistory.length
      || (Number.isFinite(Number(lead.preActivityUpdates)) ? Number(lead.preActivityUpdates) : 0);
    lead.postActivityUpdates = lead.admissionActivityHistory.length
      || (Number.isFinite(Number(lead.postActivityUpdates)) ? Number(lead.postActivityUpdates) : 0);
    lead.whatsappGroupStatus = lead.whatsappGroupStatus || "";
    lead.leadNotes = Array.isArray(lead.leadNotes) ? lead.leadNotes : [];
  });
}

function getAllLeads() {
  const leads = getStoredLeads();
  normalizeLeadFields(leads);
  return leads;
}

function saveAllLeads(leads) {
  return persistLeads(leads);
}

async function restoreLead(leadId) {
  const allLeads = getAllLeads();
  const index = allLeads.findIndex((lead) => String(lead.id) === String(leadId));
  if (index === -1) {
    return;
  }

  const confirmed = window.confirm("Restore this lead back to Admission Calling?");
  if (!confirmed) {
    return;
  }

  allLeads[index] = {
    ...allLeads[index],
    courseStatus: "",
    postStatusUpdated: false
  };

  const restoreResult = await saveAllLeads(allLeads);
  if (!restoreResult || restoreResult.ok === false) {
    window.alert("Failed to restore lead. Please check your connection and try again.");
    return;
  }
  renderAll();
}

function isPostWorkshopLead(lead) {
  return lead.wsStatus === "Interested" && lead.whatsappInvite === "Yes";
}

function isLostLead(lead) {
  return lead.postStatusUpdated && lead.courseStatus === "Not Interested";
}

function getLostSource(lead) {
  if (lead.postStatusUpdated && lead.courseStatus === "Not Interested") {
    return "Admission Calling";
  }

  return "Unknown";
}

function renderKpi(lostLeads) {
  lostKpiSection.innerHTML = `
    <article class="card kpi-card">
      <p>Overall Lost Leads</p>
      <h2>${lostLeads.length}</h2>
    </article>
  `;
}

function renderTable(lostLeads) {
  const isAdmin = session?.role === "admin";
  let html = `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Lead Import Date</th>
            <th>Name</th>
            <th>Phone Number</th>
            <th>Email</th>
            <th>Workshop Name</th>
            <th>Counselor</th>
            <th>Lost Stage</th>
            ${isAdmin ? "<th>Actions</th>" : ""}
          </tr>
        </thead>
        <tbody>
  `;

  if (!lostLeads.length) {
    html += `<tr><td colspan="${isAdmin ? 8 : 7}">No lost leads found.</td></tr>`;
  } else {
    html += lostLeads
      .map(
        (lead) => `
      <tr>
        <td>${lead.createdAt}</td>
        <td>${lead.name}</td>
        <td>${lead.phone || "-"}</td>
        <td>${lead.email}</td>
        <td>${lead.workshop}</td>
        <td>${lead.counselor || "Unassigned"}</td>
        <td>${getLostSource(lead)}</td>
        ${isAdmin ? `<td><button class="btn-ghost btn-restore-lead" type="button" data-lead-id="${lead.id}">Restore</button></td>` : ""}
      </tr>
    `
      )
      .join("");
  }

  html += `</tbody></table></div>`;
  lostLeadTableSection.innerHTML = html;

  if (isAdmin) {
    document.querySelectorAll(".btn-restore-lead").forEach((button) => {
      button.onclick = () => {
        const leadId = button.getAttribute("data-lead-id");
        if (leadId) {
          void restoreLead(leadId);
        }
      };
    });
  }
}

function renderAll() {
  const allLeads = getAllLeads();
  const scopedLeads = getScopedLeads(allLeads);
  let lostLeads = scopedLeads.filter((lead) => isLostLead(lead));

  if (searchQuery) {
    const query = searchQuery.toLowerCase();
    lostLeads = lostLeads.filter((lead) => {
      const haystack = [
        lead.name,
        lead.email,
        lead.phone,
        lead.workshop,
        lead.counselor
      ]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");

      return haystack.includes(query);
    });
  }

  renderKpi(lostLeads);
  renderTable(lostLeads);
}

if (lostSearchInput) {
  lostSearchInput.oninput = () => {
    searchQuery = String(lostSearchInput.value || "").trim();
    persistSearchQuery();
    renderAll();
  };
}

if (resetLostSearch) {
  resetLostSearch.onclick = () => {
    searchQuery = "";
    if (lostSearchInput) {
      lostSearchInput.value = "";
    }
    persistSearchQuery();
    renderAll();
  };
}

renderAll();
const stopStatePolling = startStatePolling(() => {
  renderAll();
});
registerPageCleanup(stopStatePolling);
