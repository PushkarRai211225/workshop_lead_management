import { registerPageCleanup } from "./page-runtime.js";
import {
  bootstrapLocalState,
  getCounselors as getStoredCounselors,
  getLeads as getStoredLeads,
  getSession,
  loadPersistedValue,
  saveLeads as persistLeads,
  savePersistedValue,
  startStatePolling
} from "./state-sync.js";
import { createTask, TASK_CATEGORY } from "./task-service.js";

await bootstrapLocalState();

const postKpiSection = document.getElementById("postKpiSection");
const postFilterBar = document.getElementById("postFilterBar");
const postActivityMessage = document.getElementById("postActivityMessage");
const postLeadTableSection = document.getElementById("postLeadTableSection");
const taskModal = document.getElementById("taskModal");
const taskModalTitle = document.getElementById("taskModalTitle");
const taskForm = document.getElementById("taskForm");
const taskLeadIdInput = document.getElementById("taskLeadId");
const taskCategoryInput = document.getElementById("taskCategory");
const taskLeadNameInput = document.getElementById("taskLeadName");
const taskCounselorInput = document.getElementById("taskCounselor");
const taskTitleInput = document.getElementById("taskTitle");
const taskNotesInput = document.getElementById("taskNotes");
const taskDueDateInput = document.getElementById("taskDueDate");
const taskMessage = document.getElementById("taskMessage");

const session = getSession();
const isAdmin = session?.role === "admin";
const canCreateTasks = session?.role === "counselor";

const DEFAULT_FILTER = {
  search: "",
  workshop: "All",
  counselor: "All",
  activityStatus: "All",
  postDialed: "All",
  coursePitched: "All",
  admissionStatus: "All",
  courseStatus: "All",
  workshopCallingDialed: "All",
  workshopCallingCallStatus: "All",
  workshopCallingWsStatus: "All",
  workshopCallingWhatsappInvite: "All"
};

const FILTER_STORAGE_KEY = "dvWorkshopAdmissionCallingFilters";
const persistedFilter = await loadPersistedValue(FILTER_STORAGE_KEY, {});

if (persistedFilter.workshopCalling && !persistedFilter.workshopCallingWsStatus) {
  persistedFilter.workshopCallingWsStatus = persistedFilter.workshopCalling;
}

let filter = {
  ...DEFAULT_FILTER,
  ...persistedFilter
};

let modalLeadId = null;
let modalMode = "edit";
let selectedLeadIds = new Set();

const activityFields = ["modalPostDialed", "modalCoursePitched", "modalCourseStatus", "modalAdmissionStatus"];

function setMessage(text, isError = true) {
  if (!postActivityMessage) {
    return;
  }

  postActivityMessage.textContent = text;
  postActivityMessage.style.color = isError ? "var(--danger)" : "var(--success)";
}

function persistFilterState() {
  void savePersistedValue(FILTER_STORAGE_KEY, filter);
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
  const counselors = getStoredCounselors();
  const match = counselors.find(
    (item) => String(item.email || "").trim().toLowerCase() === sessionEmail
  );

  return String(match?.name || session?.name || "").trim().toLowerCase() || sessionName;
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

function getLeadActivityUpdateCount(lead) {
  const workshopUpdates = Array.isArray(lead?.workshopActivityHistory)
    ? lead.workshopActivityHistory.length
    : Number(lead?.preActivityUpdates) || 0;
  const admissionUpdates = Array.isArray(lead?.admissionActivityHistory)
    ? lead.admissionActivityHistory.length
    : Number(lead?.postActivityUpdates) || 0;

  return workshopUpdates + admissionUpdates;
}

function isUntouchedLead(lead) {
  return getLeadActivityUpdateCount(lead) === 0;
}

function normalizeLeadFields(leads) {
  leads.forEach((lead) => {
    lead.dialed = lead.dialed || "";
    lead.callStatus = lead.callStatus || "";
    lead.wsStatus = lead.wsStatus || "";
    lead.whatsappInvite = lead.whatsappInvite || "";

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

function showToast(message, isError = false) {
  let container = document.getElementById("dvToastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "dvToastContainer";
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast ${isError ? "toast--error" : "toast--success"}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("toast--fade");
    setTimeout(() => toast.remove(), 350);
  }, 3000);
}

function isLostLead(lead) {
  return lead.wsStatus === "Not Interested" || (lead.postStatusUpdated && lead.courseStatus === "Not Interested");
}

function getAdmissionCallingLeads(allLeads) {
  return allLeads.filter((lead) => !isLostLead(lead));
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
  const counselorOptions = [...new Set(
    leads
      .map((lead) => String(lead.counselor || "").trim())
      .filter((name) => name && name.toLowerCase() !== "unassigned")
  )];
  const workshopCallingDialedOptions = getUniqueValues(leads, "dialed");
  const workshopCallingCallStatusOptions = getUniqueValues(leads, "callStatus");
  const workshopCallingWsStatusOptions = getUniqueValues(leads, "wsStatus");
  const workshopCallingWhatsappInviteOptions = getUniqueValues(leads, "whatsappInvite");
  const postDialedOptions = getUniqueValues(leads, "postDialed");
  const coursePitchedOptions = getUniqueValues(leads, "coursePitched");
  const admissionOptions = getUniqueValues(leads, "admissionStatus");

  postFilterBar.innerHTML = `
    <div class="filter-section">
      <div class="filter-section-title">Workshop Calling</div>
      <div class="filter-row">
        <div class="filter-item">
          <label for="postWorkshopCallingDialedSelect">Dialed</label>
          <select id="postWorkshopCallingDialedSelect">
            <option value="All">All</option>
            ${workshopCallingDialedOptions.map((value) => `<option value="${value}">${value}</option>`).join("")}
          </select>
        </div>
        <div class="filter-item">
          <label for="postWorkshopCallingCallStatusSelect">Call Status</label>
          <select id="postWorkshopCallingCallStatusSelect">
            <option value="All">All</option>
            ${workshopCallingCallStatusOptions.map((value) => `<option value="${value}">${value}</option>`).join("")}
          </select>
        </div>
        <div class="filter-item">
          <label for="postWorkshopCallingWsStatusSelect">Workshop Status</label>
          <select id="postWorkshopCallingWsStatusSelect">
            <option value="All">All</option>
            ${workshopCallingWsStatusOptions.map((value) => `<option value="${value}">${value}</option>`).join("")}
          </select>
        </div>
        <div class="filter-item">
          <label for="postWorkshopCallingWhatsappInviteSelect">WhatsApp Invite</label>
          <select id="postWorkshopCallingWhatsappInviteSelect">
            <option value="All">All</option>
            ${workshopCallingWhatsappInviteOptions.map((value) => `<option value="${value}">${value}</option>`).join("")}
          </select>
        </div>
      </div>
    </div>

    <div class="filter-section">
      <div class="filter-section-title">Admission Calling</div>
      <div class="filter-row">
        <div class="filter-item">
          <label for="postSearchLeadInput">Search Lead</label>
          <input id="postSearchLeadInput" type="text" placeholder="Name, email, phone, workshop, counselor" />
        </div>
        <div class="filter-item${isAdmin ? "" : " hidden"}" data-admin-only="true">
          <label for="postCounselorSelect">Counselor</label>
          <select id="postCounselorSelect">
            <option value="All">All</option>
            ${counselorOptions.map((value) => `<option value="${value}">${value}</option>`).join("")}
          </select>
        </div>
        <div class="filter-item">
          <label for="postActivityStatusSelect">Untouched Leads</label>
          <select id="postActivityStatusSelect">
            <option value="All">All</option>
            <option value="Untouched">Untouched Only</option>
            <option value="Updated">Updated Only</option>
          </select>
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
            <button id="postResetFilters" class="btn-ghost" type="button">Reset</button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById("postWorkshopCallingDialedSelect").value = filter.workshopCallingDialed;
  document.getElementById("postWorkshopCallingCallStatusSelect").value = filter.workshopCallingCallStatus;
  document.getElementById("postWorkshopCallingWsStatusSelect").value = filter.workshopCallingWsStatus;
  document.getElementById("postWorkshopCallingWhatsappInviteSelect").value = filter.workshopCallingWhatsappInvite;
  document.getElementById("postSearchLeadInput").value = filter.search;
  document.getElementById("postCounselorSelect").value = filter.counselor;
  document.getElementById("postActivityStatusSelect").value = filter.activityStatus;
  document.getElementById("postWorkshopSelect").value = filter.workshop;
  document.getElementById("postDialedSelect").value = filter.postDialed;
  document.getElementById("postCoursePitchedSelect").value = filter.coursePitched;
  document.getElementById("postCourseStatusSelect").value = filter.courseStatus;
  document.getElementById("postAdmissionStatusSelect").value = filter.admissionStatus;

  document.getElementById("postWorkshopCallingDialedSelect").onchange = (event) => {
    filter.workshopCallingDialed = event.target.value;
    persistFilterState();
    renderAll();
  };

  document.getElementById("postWorkshopCallingCallStatusSelect").onchange = (event) => {
    filter.workshopCallingCallStatus = event.target.value;
    persistFilterState();
    renderAll();
  };

  document.getElementById("postWorkshopCallingWsStatusSelect").onchange = (event) => {
    filter.workshopCallingWsStatus = event.target.value;
    persistFilterState();
    renderAll();
  };

  document.getElementById("postWorkshopCallingWhatsappInviteSelect").onchange = (event) => {
    filter.workshopCallingWhatsappInvite = event.target.value;
    persistFilterState();
    renderAll();
  };

  document.getElementById("postSearchLeadInput").oninput = (event) => {
    filter.search = event.target.value.trim();
    persistFilterState();
    renderAll();
  };

  document.getElementById("postCounselorSelect").onchange = (event) => {
    filter.counselor = event.target.value;
    persistFilterState();
    renderAll();
  };

  document.getElementById("postActivityStatusSelect").onchange = (event) => {
    filter.activityStatus = event.target.value;
    persistFilterState();
    renderAll();
  };

  document.getElementById("postWorkshopSelect").onchange = (event) => {
    filter.workshop = event.target.value;
    persistFilterState();
    renderAll();
  };

  document.getElementById("postDialedSelect").onchange = (event) => {
    filter.postDialed = event.target.value;
    persistFilterState();
    renderAll();
  };

  document.getElementById("postCoursePitchedSelect").onchange = (event) => {
    filter.coursePitched = event.target.value;
    persistFilterState();
    renderAll();
  };

  document.getElementById("postCourseStatusSelect").onchange = (event) => {
    filter.courseStatus = event.target.value;
    persistFilterState();
    renderAll();
  };

  document.getElementById("postAdmissionStatusSelect").onchange = (event) => {
    filter.admissionStatus = event.target.value;
    persistFilterState();
    renderAll();
  };

  document.getElementById("postResetFilters").onclick = () => {
    filter = { ...DEFAULT_FILTER };
    persistFilterState();
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

  if (filter.counselor !== "All") {
    filtered = filtered.filter((lead) => String(lead.counselor || "").trim() === filter.counselor);
  }

  if (filter.activityStatus === "Untouched") {
    filtered = filtered.filter((lead) => isUntouchedLead(lead));
  }

  if (filter.activityStatus === "Updated") {
    filtered = filtered.filter((lead) => !isUntouchedLead(lead));
  }

  if (filter.workshopCallingDialed !== "All") {
    filtered = filtered.filter((lead) => lead.dialed === filter.workshopCallingDialed);
  }

  if (filter.workshopCallingCallStatus !== "All") {
    filtered = filtered.filter((lead) => lead.callStatus === filter.workshopCallingCallStatus);
  }

  if (filter.workshopCallingWsStatus !== "All") {
    filtered = filtered.filter((lead) => lead.wsStatus === filter.workshopCallingWsStatus);
  }

  if (filter.workshopCallingWhatsappInvite !== "All") {
    filtered = filtered.filter((lead) => lead.whatsappInvite === filter.workshopCallingWhatsappInvite);
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
  const hasActivity = Array.isArray(lead.admissionActivityHistory) && lead.admissionActivityHistory.length > 0;
  return `
    <div class="activity-panel">
      <button class="btn-view-activity" type="button" data-lead-id="${lead.id}" aria-label="View activity details" title="View activity details">👁</button>
      <button class="btn-update-status${hasActivity ? " btn-update-status--active" : ""}" data-lead-id="${lead.id}">Update</button>
      ${canCreateTasks ? `<button class="btn-ghost btn-task" type="button" data-lead-id="${lead.id}">Task</button>` : ""}
      ${isAdmin ? `<button class="btn-delete" type="button" data-lead-id="${lead.id}">Delete</button>` : ""}
    </div>
  `;
}

function renderLeadTable(leads) {
  syncSelectedLeadIds(leads);
  const selectedCount = isAdmin ? getSelectedLeadCount(leads) : 0;
  const allSelected = isAdmin && leads.length > 0 && selectedCount === leads.length;
  const selectionColumn = isAdmin
    ? `
            <th class="selection-header">
              <label class="bulk-select-control">
                <input id="postBulkSelect" type="checkbox" ${allSelected ? "checked" : ""} />
                <span>Select All</span>
              </label>
              <div class="bulk-select-actions">
                <span class="selected-count">Selected: ${selectedCount}</span>
                <button id="postBulkDelete" class="btn-delete bulk-delete-btn" type="button" ${selectedCount ? "" : "disabled"}>Delete Selected</button>
              </div>
            </th>
    `
    : "";
  const emptyColspan = isAdmin ? 7 : 6;

  let html = `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            ${selectionColumn}
            <th>Lead Import Date</th>
            <th>Name</th>
            <th>Phone Number</th>
            <th>Email</th>
            <th>Workshop Name</th>
            <th>Admission Calling Activity</th>
          </tr>
        </thead>
        <tbody>
  `;

  if (!leads.length) {
    html += `<tr><td colspan="${emptyColspan}">No admission calling leads available for current filters.</td></tr>`;
  } else {
    html += leads
      .map(
        (lead) => `
      <tr>
        ${isAdmin ? `
        <td>
          <input class="lead-select-checkbox" type="checkbox" data-lead-id="${lead.id}" ${isLeadSelected(lead.id) ? "checked" : ""} />
        </td>
        ` : ""}
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

  document.querySelectorAll(".btn-view-activity").forEach((button) => {
    button.onclick = () => {
      const leadId = button.getAttribute("data-lead-id");
      openPostActivityDetailsModal(leadId);
    };
  });

  document.querySelectorAll(".btn-update-status").forEach((button) => {
    button.onclick = () => {
      const leadId = button.getAttribute("data-lead-id");
      openPostActivityModal(leadId);
    };
  });

  document.querySelectorAll(".btn-task").forEach((button) => {
    button.onclick = () => {
      const leadId = button.getAttribute("data-lead-id");
      openTaskModal(leadId);
    };
  });

  document.querySelectorAll(".btn-delete").forEach((button) => {
    button.onclick = () => {
      const leadId = button.getAttribute("data-lead-id");
      if (leadId && deleteLead(leadId)) {
        clearSelectedLeadIds();
        renderAll();
      }
    };
  });

  const bulkSelect = document.getElementById("postBulkSelect");
  if (bulkSelect) {
    bulkSelect.onchange = (event) => {
      toggleAllLeadsSelection(leads, event.target.checked);
      renderAll();
    };
  }

  const bulkDelete = document.getElementById("postBulkDelete");
  if (bulkDelete) {
    bulkDelete.onclick = () => {
      if (deleteSelectedLeads(leads)) {
        renderAll();
      }
    };
  }

  document.querySelectorAll(".lead-select-checkbox").forEach((checkbox) => {
    checkbox.onchange = (event) => {
      const leadId = checkbox.getAttribute("data-lead-id");
      if (leadId) {
        toggleLeadSelection(leadId, event.target.checked);
        renderAll();
      }
    };
  });
}

function setPostActivityModalMode(mode) {
  modalMode = mode;
  const title = document.getElementById("postActivityModalTitle");
  const saveButton = document.getElementById("savePostActivityBtn");

  if (title) {
    title.textContent = mode === "view" ? "Activity Details" : "Update Admission Calling Activity";
  }

  if (saveButton) {
    saveButton.classList.toggle("hidden", mode === "view");
  }

  activityFields.forEach((fieldId) => {
    const field = document.getElementById(fieldId);
    if (field) {
      field.disabled = mode === "view";
    }
  });
}

function populatePostActivityModal(lead) {
  document.getElementById("modalPostDialed").value = lead.postDialed;
  document.getElementById("modalCoursePitched").value = lead.coursePitched;
  document.getElementById("modalCourseStatus").value = lead.courseStatus;
  document.getElementById("modalAdmissionStatus").value = lead.admissionStatus;
}

async function updatePostActivity(leadId, updates) {
  const allLeads = getAllLeads();
  const index = allLeads.findIndex((lead) => String(lead.id) === String(leadId));
  if (index === -1) {
    return false;
  }

  if (isCounselorSession()) {
    const owner = String(allLeads[index].counselor || "").trim().toLowerCase();
    if (owner !== getCounselorIdentity()) {
      return false;
    }
  }

  const workshopActivityCount = Array.isArray(allLeads[index].workshopActivityHistory)
    ? allLeads[index].workshopActivityHistory.length
    : Number(allLeads[index].preActivityUpdates) || 0;
  if (!workshopActivityCount) {
    const confirmed = window.confirm(
      "The lead has not been called for Workshop Calling. Do you still want to update the details?"
    );

    if (!confirmed) {
      return false;
    }
  }

  const admissionHistory = Array.isArray(allLeads[index].admissionActivityHistory)
    ? allLeads[index].admissionActivityHistory
    : [];
  const nextAdmissionHistory = [
    ...admissionHistory,
    {
      at: new Date().toISOString(),
      source: "Admission Calling",
      updates
    }
  ];

  allLeads[index] = {
    ...allLeads[index],
    ...updates,
    admissionActivityHistory: nextAdmissionHistory,
    postActivityUpdates: nextAdmissionHistory.length,
    postStatusUpdated: true
  };

  try {
    const result = await saveAllLeads(allLeads);
    if (result && result.ok === false) {
      showToast("Failed to save activity. Please check your connection and try again.", true);
      return false;
    }

    showToast(
      updates.courseStatus === "Not Interested"
        ? "Lead moved to Lost Leads."
        : "Admission Calling activity saved successfully.",
      false
    );
    return true;
  } catch (err) {
    console.error("[post-workshop] Failed to persist leads:", err);
    showToast("Failed to save activity. Please check your connection and try again.", true);
    return false;
  }
}

function deleteLead(leadId) {
  const allLeads = getAllLeads();
  const index = allLeads.findIndex((lead) => String(lead.id) === String(leadId));
  if (index === -1) {
    return false;
  }

  const confirmed = window.confirm("Delete this lead? This cannot be undone.");
  if (!confirmed) {
    return false;
  }

  allLeads.splice(index, 1);
  saveAllLeads(allLeads);
  setMessage("Lead deleted successfully.", false);
  return true;
}

function deleteSelectedLeads(leads) {
  const selectedIds = [...selectedLeadIds].map((leadId) => String(leadId));
  if (!selectedIds.length) {
    return false;
  }

  const confirmed = window.confirm(`Delete ${selectedIds.length} selected lead${selectedIds.length === 1 ? "" : "s"}? This cannot be undone.`);
  if (!confirmed) {
    return false;
  }

  const remainingLeads = leads.filter((lead) => !selectedIds.includes(String(lead.id)));
  const removedCount = leads.length - remainingLeads.length;
  if (!removedCount) {
    return false;
  }

  saveAllLeads(remainingLeads);
  clearSelectedLeadIds();
  setMessage(`Deleted ${removedCount} selected lead${removedCount === 1 ? "" : "s"}.`, false);
  return true;
}

function clearSelectedLeadIds() {
  selectedLeadIds = new Set();
}

function getSelectableLeadIds(leads) {
  return leads.map((lead) => String(lead.id));
}

function getSelectedLeadCount(leads) {
  const selectableIds = new Set(getSelectableLeadIds(leads));
  let count = 0;

  selectedLeadIds.forEach((leadId) => {
    if (selectableIds.has(String(leadId))) {
      count += 1;
    }
  });

  return count;
}

function syncSelectedLeadIds(leads) {
  const selectableIds = new Set(getSelectableLeadIds(leads));
  selectedLeadIds = new Set([...selectedLeadIds].filter((leadId) => selectableIds.has(String(leadId))));
}

function toggleLeadSelection(leadId, isChecked) {
  const next = new Set(selectedLeadIds);
  if (isChecked) {
    next.add(String(leadId));
  } else {
    next.delete(String(leadId));
  }
  selectedLeadIds = next;
}

function toggleAllLeadsSelection(leads, isChecked) {
  selectedLeadIds = isChecked ? new Set(getSelectableLeadIds(leads)) : new Set();
}

function isLeadSelected(leadId) {
  return selectedLeadIds.has(String(leadId));
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

  setPostActivityModalMode("edit");
  populatePostActivityModal(lead);
  document.getElementById("postActivityModal").classList.remove("hidden");
}

function openPostActivityDetailsModal(leadId) {
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

  setPostActivityModalMode("view");
  populatePostActivityModal(lead);
  document.getElementById("postActivityModal").classList.remove("hidden");
}

function closePostModal() {
  document.getElementById("postActivityModal").classList.add("hidden");
  modalLeadId = null;
  setPostActivityModalMode("edit");
}

function setTaskMessage(text, isError = true) {
  if (!taskMessage) {
    return;
  }

  taskMessage.textContent = text;
  taskMessage.style.color = isError ? "var(--danger)" : "var(--success)";
}

function closeTaskModal() {
  if (taskModal) {
    taskModal.classList.add("hidden");
  }
  setTaskMessage("");
}

function openTaskModal(leadId) {
  if (!canCreateTasks) {
    return;
  }

  const allLeads = getAllLeads();
  const lead = allLeads.find((item) => String(item.id) === String(leadId));
  if (!lead) {
    return;
  }

  if (String(lead.counselor || "").trim().toLowerCase() !== getCounselorIdentity()) {
    return;
  }

  taskLeadIdInput.value = lead.id;
  taskCategoryInput.value = TASK_CATEGORY.admission;
  taskLeadNameInput.value = lead.name || "";
  taskCounselorInput.value = lead.counselor || "Unassigned";
  taskTitleInput.value = `Follow up with ${lead.name || "lead"}`;
  taskNotesInput.value = "";
  taskDueDateInput.value = "";
  setTaskMessage("");
  taskModalTitle.textContent = "Create Admission Task";
  taskModal.classList.remove("hidden");
}

async function handleTaskSubmit(event) {
  event.preventDefault();

  const leadId = taskLeadIdInput.value;
  const title = taskTitleInput.value.trim();
  const dueDate = taskDueDateInput.value;

  if (!leadId || !title || !dueDate) {
    setTaskMessage("Title and due date are required.", true);
    return;
  }

  const allLeads = getAllLeads();
  const lead = allLeads.find((item) => String(item.id) === String(leadId));
  if (!lead) {
    setTaskMessage("Lead not found.", true);
    return;
  }

  await createTask({
    leadId: lead.id,
    leadName: lead.name,
    leadCounselor: lead.counselor || "Unassigned",
    counselor: session?.name || lead.counselor || "Unassigned",
    category: TASK_CATEGORY.admission,
    title,
    notes: taskNotesInput.value.trim(),
    dueDate
  });

  setTaskMessage("Task created and sent to Task Tracker.", false);
  closeTaskModal();
}

function initPostWorkshopPage() {
  const modal = document.getElementById("postActivityModal");
  if (!modal) {
    return;
  }

  document.getElementById("closePostModalBtn").onclick = closePostModal;
  document.getElementById("postActivityForm").onsubmit = async (event) => {
    event.preventDefault();
    if (!modalLeadId) {
      return;
    }

    const saved = await updatePostActivity(modalLeadId, {
      postDialed: document.getElementById("modalPostDialed").value,
      coursePitched: document.getElementById("modalCoursePitched").value,
      courseStatus: document.getElementById("modalCourseStatus").value,
      admissionStatus: document.getElementById("modalAdmissionStatus").value,
      postStatusUpdated: true
    });

    if (!saved) {
      return;
    }

    closePostModal();
    renderAll();
  };
}

  if (taskModal && taskForm) {
    document.getElementById("closeTaskModalBtn").onclick = closeTaskModal;
    taskForm.onsubmit = handleTaskSubmit;
  }

  document.querySelectorAll(".btn-task").forEach((button) => {
    button.addEventListener("click", () => {
      const leadId = button.getAttribute("data-lead-id");
      if (leadId) {
        openTaskModal(leadId);
      }
    });
  });

initPostWorkshopPage();

function renderAll() {
  const allLeads = getAllLeads();
  normalizeLeadFields(allLeads);

  const scopedLeads = getScopedLeads(allLeads);
  const admissionLeads = getAdmissionCallingLeads(scopedLeads);
  const filteredLeads = filterLeads(admissionLeads);

  renderKpis(filteredLeads);
  renderFilters(admissionLeads);
  renderLeadTable(filteredLeads);
}

renderAll();
const stopStatePolling = startStatePolling(() => {
  renderAll();
});
registerPageCleanup(stopStatePolling);
