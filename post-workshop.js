import { bootstrapLocalState, syncStateFromLocal } from "./state-sync.js";

const LEADS_KEY = "dvWorkshopLeads";
const SESSION_KEY = "dvWorkshopSession";
const COUNSELORS_KEY = "dvCounselors";

await bootstrapLocalState();

const postKpiSection = document.getElementById("postKpiSection");
const postFilterBar = document.getElementById("postFilterBar");
const postLeadTableSection = document.getElementById("postLeadTableSection");

const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");

let filter = {
  search: "",
  workshop: "All",
  postDialed: "All",
  coursePitched: "All",
  admissionStatus: "All",
  courseStatus: "All"
};

const DEFAULT_FILTER = {
  search: "",
  workshop: "All",
  postDialed: "All",
  coursePitched: "All",
  admissionStatus: "All",
  courseStatus: "All"
};

let modalLeadId = null;

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
    lead.dialed = lead.dialed || "No";
    lead.callStatus = lead.callStatus || "CNC";
    // Missing wsStatus should not imply the lead is lost.
    lead.wsStatus = lead.wsStatus || "Interested";
    lead.whatsappInvite = lead.whatsappInvite || "No";

    lead.postDialed = lead.postDialed || "No";
    lead.coursePitched = lead.coursePitched || "No";
    lead.courseStatus = lead.courseStatus || "Interested";
    lead.admissionStatus = lead.admissionStatus || "In-Converstion";
    lead.postStatusUpdated = typeof lead.postStatusUpdated === "boolean" ? lead.postStatusUpdated : false;
    lead.preActivityUpdates = Number.isFinite(Number(lead.preActivityUpdates)) ? Number(lead.preActivityUpdates) : 0;
    lead.postActivityUpdates = Number.isFinite(Number(lead.postActivityUpdates)) ? Number(lead.postActivityUpdates) : 0;
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

function saveAllLeads(leads) {
  localStorage.setItem(LEADS_KEY, JSON.stringify(leads));
  void syncStateFromLocal();
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

function getPostWorkshopLeads(allLeads) {
  return allLeads.filter((lead) => isPostWorkshopLead(lead) && !isLostLead(lead));
}

function getUniqueValues(leads, key) {
  return [
    ...new Set(
      leads
        .map((lead) => lead[key])
        .filter((value) => typeof value === "string" && value.trim() !== "")
    )
  ];
}

function renderKpis(leads) {
  const interested = leads.filter((lead) => lead.courseStatus === "Interested").length;
  const enrolled = leads.filter((lead) => lead.admissionStatus === "Enrolled").length;
  const won = leads.filter((lead) => lead.admissionStatus === "Won").length;

  postKpiSection.innerHTML = `
    <article class="card kpi-card">
      <p>Overall Leads</p>
      <h2>${leads.length}</h2>
    </article>
    <article class="card kpi-card">
      <p>Interested</p>
      <h2>${interested}</h2>
    </article>
    <article class="card kpi-card">
      <p>Enrolled</p>
      <h2>${enrolled}</h2>
    </article>
    <article class="card kpi-card">
      <p>Won</p>
      <h2>${won}</h2>
    </article>
  `;
}

function renderFilters(leads) {
  const workshops = getUniqueValues(leads, "workshop");
  const postDialedOptions = getUniqueValues(leads, "postDialed");
  const coursePitchedOptions = getUniqueValues(leads, "coursePitched");
  const admissionOptions = getUniqueValues(leads, "admissionStatus");

  postFilterBar.innerHTML = `
    <div class="filter-row">
      <div class="filter-item">
        <label for="postSearchLeadInput">Search Lead</label>
        <input id="postSearchLeadInput" type="text" placeholder="Name, email, phone, workshop, counselor" />
      </div>
      <div class="filter-item">
        <label for="postWorkshopSelect">Workshop Name</label>
        <select id="postWorkshopSelect">
          <option value="All">All</option>
          ${workshops.map((value) => `<option value="${value}">${value}</option>`).join("")}
        </select>
      </div>
      <div class="filter-item">
        <label for="postDialedSelect">Dialed</label>
        <select id="postDialedSelect">
          <option value="All">All</option>
          ${postDialedOptions.map((value) => `<option value="${value}">${value}</option>`).join("")}
        </select>
      </div>
      <div class="filter-item">
        <label for="postCoursePitchedSelect">Course Pitched</label>
        <select id="postCoursePitchedSelect">
          <option value="All">All</option>
          ${coursePitchedOptions.map((value) => `<option value="${value}">${value}</option>`).join("")}
        </select>
      </div>
      <div class="filter-item">
        <label for="postCourseStatusSelect">Course Status</label>
        <select id="postCourseStatusSelect">
          <option value="All">All</option>
          <option value="Interested">Interested</option>
          <option value="Not Interested">Not Interested</option>
        </select>
      </div>
      <div class="filter-item">
        <label for="postAdmissionStatusSelect">Admission</label>
        <select id="postAdmissionStatusSelect">
          <option value="All">All</option>
          ${admissionOptions.map((value) => `<option value="${value}">${value}</option>`).join("")}
        </select>
      </div>
      <div class="filter-item filter-item-cta">
        <label>&nbsp;</label>
        <div class="filter-actions">
          <button id="postApplyFilters" class="btn-ghost" type="button">Apply</button>
          <button id="postResetFilters" class="btn-ghost" type="button">Reset</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("postSearchLeadInput").value = filter.search;
  document.getElementById("postWorkshopSelect").value = filter.workshop;
  document.getElementById("postDialedSelect").value = filter.postDialed;
  document.getElementById("postCoursePitchedSelect").value = filter.coursePitched;
  document.getElementById("postCourseStatusSelect").value = filter.courseStatus;
  document.getElementById("postAdmissionStatusSelect").value = filter.admissionStatus;

  document.getElementById("postSearchLeadInput").oninput = (event) => {
    filter.search = event.target.value.trim();
  };

  document.getElementById("postWorkshopSelect").onchange = (event) => {
    filter.workshop = event.target.value;
  };

  document.getElementById("postDialedSelect").onchange = (event) => {
    filter.postDialed = event.target.value;
  };

  document.getElementById("postCoursePitchedSelect").onchange = (event) => {
    filter.coursePitched = event.target.value;
  };

  document.getElementById("postCourseStatusSelect").onchange = (event) => {
    filter.courseStatus = event.target.value;
  };

  document.getElementById("postAdmissionStatusSelect").onchange = (event) => {
    filter.admissionStatus = event.target.value;
  };

  document.getElementById("postApplyFilters").onclick = () => {
    renderAll();
  };

  document.getElementById("postResetFilters").onclick = () => {
    filter = { ...DEFAULT_FILTER };
    renderAll();
  };
}

function filterLeads(leads) {
  let filtered = [...leads];

  if (filter.search) {
    const query = filter.search.toLowerCase();
    filtered = filtered.filter((lead) => {
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

  if (filter.workshop !== "All") {
    filtered = filtered.filter((lead) => lead.workshop === filter.workshop);
  }

  if (filter.postDialed !== "All") {
    filtered = filtered.filter((lead) => lead.postDialed === filter.postDialed);
  }

  if (filter.coursePitched !== "All") {
    filtered = filtered.filter((lead) => lead.coursePitched === filter.coursePitched);
  }

  if (filter.courseStatus !== "All") {
    filtered = filtered.filter((lead) => lead.courseStatus === filter.courseStatus);
  }

  if (filter.admissionStatus !== "All") {
    filtered = filtered.filter((lead) => lead.admissionStatus === filter.admissionStatus);
  }

  return filtered;
}

function renderActivityPanel(lead) {
  return `
    <div class="activity-panel">
      <span class="status-summary">Dialed: ${lead.postDialed}, Pitched: ${lead.coursePitched}, Course: ${lead.courseStatus}, Admission: ${lead.admissionStatus}</span>
      <button class="btn-update-status" data-lead-id="${lead.id}">Update</button>
    </div>
  `;
}

function renderLeadTable(leads) {
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
            <th>Post-Workshop Activity</th>
          </tr>
        </thead>
        <tbody>
  `;

  if (!leads.length) {
    html += `<tr><td colspan="6">No post-workshop leads available for current filters.</td></tr>`;
  } else {
    html += leads
      .map(
        (lead) => `
      <tr>
        <td>${lead.createdAt}</td>
        <td>${lead.name}</td>
        <td>${lead.phone || "-"}</td>
        <td>${lead.email}</td>
        <td>${lead.workshop}</td>
        <td>${renderActivityPanel(lead)}</td>
      </tr>
    `
      )
      .join("");
  }

  html += `</tbody></table></div>`;
  postLeadTableSection.innerHTML = html;

  document.querySelectorAll(".btn-update-status").forEach((button) => {
    button.onclick = () => {
      const leadId = button.getAttribute("data-lead-id");
      openPostActivityModal(leadId);
    };
  });
}

function updatePostActivity(leadId, updates) {
  const allLeads = getAllLeads();
  const index = allLeads.findIndex((lead) => String(lead.id) === String(leadId));
  if (index === -1) {
    return;
  }

  if (isCounselorSession()) {
    const owner = String(allLeads[index].counselor || "").trim().toLowerCase();
    if (owner !== getCounselorIdentity()) {
      return;
    }
  }

  allLeads[index] = {
    ...allLeads[index],
    ...updates,
    postActivityUpdates: (Number(allLeads[index].postActivityUpdates) || 0) + 1
  };

  saveAllLeads(allLeads);
}

function openPostActivityModal(leadId) {
  modalLeadId = leadId;
  const allLeads = getAllLeads();
  const lead = allLeads.find((item) => String(item.id) === String(leadId));
  if (!lead) {
    return;
  }

  if (isCounselorSession()) {
    const owner = String(lead.counselor || "").trim().toLowerCase();
    if (owner !== getCounselorIdentity()) {
      return;
    }
  }

  document.getElementById("modalPostDialed").value = lead.postDialed;
  document.getElementById("modalCoursePitched").value = lead.coursePitched;
  document.getElementById("modalCourseStatus").value = lead.courseStatus;
  document.getElementById("modalAdmissionStatus").value = lead.admissionStatus;
  document.getElementById("postActivityModal").classList.remove("hidden");
}

function closePostModal() {
  document.getElementById("postActivityModal").classList.add("hidden");
  modalLeadId = null;
}

window.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("postActivityModal");
  if (!modal) {
    return;
  }

  document.getElementById("closePostModalBtn").onclick = closePostModal;
  document.getElementById("postActivityForm").onsubmit = (event) => {
    event.preventDefault();
    if (!modalLeadId) {
      return;
    }

    updatePostActivity(modalLeadId, {
      postDialed: document.getElementById("modalPostDialed").value,
      coursePitched: document.getElementById("modalCoursePitched").value,
      courseStatus: document.getElementById("modalCourseStatus").value,
      admissionStatus: document.getElementById("modalAdmissionStatus").value,
      postStatusUpdated: true
    });

    closePostModal();
    renderAll();
  };
});

function renderAll() {
  const allLeads = getAllLeads();
  normalizeLeadFields(allLeads);
  saveAllLeads(allLeads);

  const scopedLeads = getScopedLeads(allLeads);
  const postLeads = getPostWorkshopLeads(scopedLeads);
  const filteredLeads = filterLeads(postLeads);

  renderKpis(filteredLeads);
  renderFilters(postLeads);
  renderLeadTable(filteredLeads);
}

renderAll();
