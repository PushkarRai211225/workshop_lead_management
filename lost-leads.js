import { bootstrapLocalState } from "./state-sync.js";

const LEADS_KEY = "dvWorkshopLeads";
const SESSION_KEY = "dvWorkshopSession";
const COUNSELORS_KEY = "dvCounselors";

await bootstrapLocalState();

const lostKpiSection = document.getElementById("lostKpiSection");
const lostLeadTableSection = document.getElementById("lostLeadTableSection");
const lostSearchInput = document.getElementById("lostSearchInput");
const applyLostSearch = document.getElementById("applyLostSearch");
const resetLostSearch = document.getElementById("resetLostSearch");

const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");

let searchQuery = "";

function isCounselorSession() {
  return session?.role === "counselor";
}

function getCounselorIdentity() {
  if (!isCounselorSession()) {
    return "";
  }

  const sessionName = String(session?.name || "").trim().toLowerCase();
  const sessionEmail = String(session?.email || "").trim().toLowerCase();
  const raw = localStorage.getItem(COUNSELORS_KEY);

  if (!raw) {
    return sessionName;
  }

  try {
    const counselors = JSON.parse(raw);
    if (!Array.isArray(counselors)) {
      return sessionName;
    }

    const match = counselors.find(
      (item) => String(item.email || "").trim().toLowerCase() === sessionEmail
    );

    return String(match?.name || session?.name || "").trim().toLowerCase();
  } catch {
    return sessionName;
  }
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
    lead.workshop = lead.workshop || "General";
    lead.createdAt = lead.createdAt || new Date().toISOString().slice(0, 10);

    lead.dialed = lead.dialed || "No";
    lead.callStatus = lead.callStatus || "CNC";
    // Missing wsStatus should not imply the lead is lost.
    lead.wsStatus = lead.wsStatus || "Interested";
    lead.whatsappInvite = lead.whatsappInvite || "No";
    lead.counselor = lead.counselor || "Unassigned";

    lead.postDialed = lead.postDialed || "No";
    lead.coursePitched = lead.coursePitched || "No";
    lead.courseStatus = lead.courseStatus || "Interested";
    lead.admissionStatus = lead.admissionStatus || "In-Converstion";
    lead.postStatusUpdated = typeof lead.postStatusUpdated === "boolean" ? lead.postStatusUpdated : false;
  });
}

function getAllLeads() {
  const raw = localStorage.getItem(LEADS_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    const leads = Array.isArray(parsed) ? parsed : [];
    normalizeLeadFields(leads);
    return leads;
  } catch {
    return [];
  }
}

function isPostWorkshopLead(lead) {
  return lead.wsStatus === "Interested" && lead.whatsappInvite === "Yes";
}

function isLostLead(lead) {
  if (lead.wsStatus === "Not Interested") {
    return true;
  }

  if (isPostWorkshopLead(lead) && lead.postStatusUpdated && lead.courseStatus === "Not Interested") {
    return true;
  }

  return false;
}

function getLostSource(lead) {
  if (lead.wsStatus === "Not Interested") {
    return "Pre-Workshop";
  }

  if (isPostWorkshopLead(lead) && lead.courseStatus === "Not Interested") {
    return "Post-Workshop";
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
          </tr>
        </thead>
        <tbody>
  `;

  if (!lostLeads.length) {
    html += `<tr><td colspan="7">No lost leads found.</td></tr>`;
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
      </tr>
    `
      )
      .join("");
  }

  html += `</tbody></table></div>`;
  lostLeadTableSection.innerHTML = html;
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

if (applyLostSearch) {
  applyLostSearch.onclick = () => {
    searchQuery = String(lostSearchInput?.value || "").trim();
    renderAll();
  };
}

if (resetLostSearch) {
  resetLostSearch.onclick = () => {
    searchQuery = "";
    if (lostSearchInput) {
      lostSearchInput.value = "";
    }
    renderAll();
  };
}

renderAll();
