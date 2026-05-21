import { bootstrapLocalState, syncStateFromLocal } from "./state-sync.js";

const LEADS_KEY = "dvWorkshopLeads";
const ALLOCATION_KEY = "dvCounselorAllocation";
const SESSION_KEY = "dvWorkshopSession";
const COUNSELORS_KEY = "dvCounselors";

await bootstrapLocalState();

const preKpiSection = document.getElementById("preKpiSection");
const preFilterBar = document.getElementById("preFilterBar");
const preLeadTableSection = document.getElementById("preLeadTableSection");

const adminImportPanel = document.getElementById("adminImportPanel");
const leadImportFile = document.getElementById("leadImportFile");
const importLeadsBtn = document.getElementById("importLeadsBtn");
const importSummary = document.getElementById("importSummary");
const importMessage = document.getElementById("importMessage");
const allocationRows = document.getElementById("allocationRows");
const addAllocationRowBtn = document.getElementById("addAllocationRowBtn");
const saveAllocationBtn = document.getElementById("saveAllocationBtn");
const allocationMessage = document.getElementById("allocationMessage");

const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
const isAdmin = session?.role === "admin";

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

let filter = {
  timeline: "week",
  startDate: "",
  endDate: "",
  search: "",
  workshop: "All",
  dialed: "All",
  callStatus: "All",
  wsStatus: "All",
  whatsappInvite: "All"
};

const DEFAULT_FILTER = {
  timeline: "week",
  startDate: "",
  endDate: "",
  search: "",
  workshop: "All",
  dialed: "All",
  callStatus: "All",
  wsStatus: "All",
  whatsappInvite: "All"
};

const DEFAULT_ALLOCATION = [];

let modalLeadId = null;

function toIsoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function setMessage(element, text, isError = true) {
  element.textContent = text;
  element.style.color = isError ? "#b42318" : "#0f766e";
}

function getDefaultWsStatus(lead) {
  return lead.status === "Interested" || lead.status === "Converted"
    ? "Interested"
    : "Not Interested";
}

function normalizeYesNo(value, fallback = "No") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "yes" || normalized === "y") {
    return "Yes";
  }
  if (normalized === "no" || normalized === "n") {
    return "No";
  }
  return fallback;
}

function normalizeLeadFields(leads) {
  leads.forEach((lead) => {
    lead.name = lead.name || "";
    lead.email = (lead.email || "").toLowerCase();
    lead.workshop = lead.workshop || "General";
    lead.createdAt = lead.createdAt || toIsoDate();

    lead.status = lead.status || "New";
    lead.dialed = normalizeYesNo(lead.dialed, "No");
    lead.callStatus = lead.callStatus || "CNC";
    lead.wsStatus = lead.wsStatus || getDefaultWsStatus(lead);
    lead.whatsappInvite = normalizeYesNo(lead.whatsappInvite, "No");
    lead.counselor = lead.counselor || "Unassigned";

    lead.postDialed = normalizeYesNo(lead.postDialed, "No");
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

function saveAllocation(allocation) {
  localStorage.setItem(ALLOCATION_KEY, JSON.stringify(allocation));
  void syncStateFromLocal();
}

function getAllocation() {
  const raw = localStorage.getItem(ALLOCATION_KEY);
  if (!raw) {
    localStorage.setItem(ALLOCATION_KEY, JSON.stringify(DEFAULT_ALLOCATION));
    return structuredClone(DEFAULT_ALLOCATION);
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) {
      localStorage.setItem(ALLOCATION_KEY, JSON.stringify(DEFAULT_ALLOCATION));
      return structuredClone(DEFAULT_ALLOCATION);
    }

    return parsed.map((item) => ({
      name: String(item.name || "").trim(),
      percentage: Number(item.percentage || 0)
    }));
  } catch {
    localStorage.setItem(ALLOCATION_KEY, JSON.stringify(DEFAULT_ALLOCATION));
    return structuredClone(DEFAULT_ALLOCATION);
  }
}

function getActiveCounselorNames() {
  const raw = localStorage.getItem(COUNSELORS_KEY);
  let names = [];

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        names = parsed
          .map((item) => String(item.name || "").trim())
          .filter(Boolean);
      }
    } catch {
      names = [];
    }
  }

  if (!names.length) {
    names = getAllocation()
      .map((item) => String(item.name || "").trim())
      .filter(Boolean);
  }

  if (!names.length) {
    names = getAllLeads()
      .map((lead) => String(lead.counselor || "").trim())
      .filter((name) => name && name.toLowerCase() !== "unassigned");
  }

  return [...new Set(names)];
}

function syncAllocationWithCounselors() {
  const counselorNames = getActiveCounselorNames();
  const existing = getAllocation();
  const byName = new Map(
    existing.map((item) => [String(item.name || "").trim().toLowerCase(), item])
  );

  const synced = counselorNames.map((name) => {
    const found = byName.get(name.toLowerCase());
    return {
      name,
      percentage: Number(found?.percentage || 0)
    };
  });

  const hasChanged =
    synced.length !== existing.length
    || synced.some((item, index) => {
      const current = existing[index];
      return !current
        || String(current.name || "").trim() !== item.name
        || Number(current.percentage || 0) !== item.percentage;
    });

  if (hasChanged) {
    saveAllocation(synced);
  }

  return synced;
}

async function fetchCounselorNamesFromApi() {
  try {
    const response = await fetch("/api/state", {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    if (!Array.isArray(payload?.counselors)) {
      return [];
    }

    return [...new Set(
      payload.counselors
        .map((item) => String(item?.name || "").trim())
        .filter(Boolean)
    )];
  } catch {
    return [];
  }
}

function mergeAllocationNames(names, existingAllocation) {
  const byName = new Map(
    existingAllocation.map((item) => [String(item.name || "").trim().toLowerCase(), Number(item.percentage || 0)])
  );

  return names.map((name) => ({
    name,
    percentage: byName.get(name.toLowerCase()) || 0
  }));
}

function validateAllocation(allocation) {
  const cleaned = allocation
    .map((item) => ({
      name: String(item.name || "").trim(),
      percentage: Number(item.percentage || 0)
    }))
    .filter((item) => item.name && item.percentage > 0);

  if (!cleaned.length) {
    return { ok: false, message: "Add at least one counselor with percentage greater than 0." };
  }

  const total = cleaned.reduce((sum, item) => sum + item.percentage, 0);
  if (Math.abs(total - 100) > 0.01) {
    return { ok: false, message: `Total allocation must be 100%. Current total: ${total.toFixed(2)}%.` };
  }

  return { ok: true, cleaned };
}

function renderAllocationRows(allocation) {
  if (!allocation.length) {
    allocationRows.innerHTML = `
      <p class="block-help">No counselors found yet. Add counselors in Counselor Management or use Add Counselor Row.</p>
    `;
    return;
  }

  allocationRows.innerHTML = allocation
    .map(
      (item, index) => `
        <div class="allocation-row" data-index="${index}">
          <input type="text" class="allocation-name" value="${item.name}" placeholder="Counselor name" />
          <input type="number" class="allocation-percentage" value="${item.percentage}" min="0" max="100" step="0.01" placeholder="%" />
        </div>
      `
    )
    .join("");
}

function readAllocationFromForm() {
  const names = Array.from(document.querySelectorAll(".allocation-name"));
  const percentages = Array.from(document.querySelectorAll(".allocation-percentage"));

  return names.map((nameInput, index) => ({
    name: nameInput.value,
    percentage: percentages[index]?.value || 0
  }));
}

function createCounselorAssignments(totalLeads, allocation) {
  if (!totalLeads) {
    return [];
  }

  if (!allocation.length) {
    return new Array(totalLeads).fill("Unassigned");
  }

  const targets = allocation.map((item) => ({
    name: item.name,
    floor: Math.floor((totalLeads * item.percentage) / 100),
    frac: (totalLeads * item.percentage) / 100 - Math.floor((totalLeads * item.percentage) / 100)
  }));

  let assigned = targets.reduce((sum, item) => sum + item.floor, 0);
  let remaining = totalLeads - assigned;

  targets
    .sort((a, b) => b.frac - a.frac)
    .forEach((item) => {
      if (remaining > 0) {
        item.floor += 1;
        remaining -= 1;
      }
    });

  const balanced = [];
  let active = true;
  while (active) {
    active = false;
    targets.forEach((item) => {
      if (item.floor > 0) {
        balanced.push(item.name);
        item.floor -= 1;
        active = true;
      }
    });
  }

  while (balanced.length < totalLeads) {
    balanced.push(allocation[0].name);
  }

  return balanced.slice(0, totalLeads);
}

function normalizeHeader(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
}

function pickValue(row, aliases) {
  const map = Object.keys(row).reduce((acc, key) => {
    acc[normalizeHeader(key)] = row[key];
    return acc;
  }, {});

  for (const alias of aliases) {
    const value = map[alias];
    if (value !== undefined && String(value).trim() !== "") {
      return value;
    }
  }

  return "";
}

function normalizeCreatedAt(value) {
  if (!value) {
    return toIsoDate();
  }

  const asDate = new Date(value);
  if (!Number.isNaN(asDate.getTime())) {
    return toIsoDate(asDate);
  }

  return toIsoDate();
}

function buildLeadFromImportRow(row, id) {
  const name = String(pickValue(row, ["name", "fullname", "leadname"])).trim();
  const email = String(pickValue(row, ["email", "emailid", "mail"])).trim().toLowerCase();
  const workshop = String(pickValue(row, ["workshop", "workshopname", "program"]))
    .trim();

  if (!name) {
    return { error: "Name is required." };
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Valid email is required." };
  }

  if (!workshop) {
    return { error: "Workshop Name is required." };
  }

  const lead = {
    id,
    name,
    email,
    phone: String(pickValue(row, ["phone", "phonenumber", "mobile", "contact"]))
      .trim(),
    workshop,
    status: String(pickValue(row, ["status"])) || "New",
    createdAt: normalizeCreatedAt(pickValue(row, ["createdat", "leadimportdate", "date"])),
    dialed: normalizeYesNo(pickValue(row, ["dialed"]), "No"),
    callStatus: String(pickValue(row, ["callstatus"])) || "CNC",
    wsStatus: String(pickValue(row, ["wsstatus", "workshopstatus"])) || "Not Interested",
    whatsappInvite: normalizeYesNo(
      pickValue(row, ["whatsappinvite", "whatsappinvitationsent", "whatsapp"]),
      "No"
    ),
    counselor: "Unassigned",
    postDialed: "No",
    coursePitched: "No",
    courseStatus: "Interested",
    admissionStatus: "In-Converstion",
    postStatusUpdated: false,
    preActivityUpdates: 0,
    postActivityUpdates: 0
  };

  return { lead };
}

async function parseImportFile(file) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return [];
  }

  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
}

function updateImportSummary(total, success, failed) {
  importSummary.innerHTML = `
    <p>Total Leads Imported: ${total}</p>
    <p>Successful Imports: ${success}</p>
    <p>Failed Entries: ${failed}</p>
  `;
}

async function handleLeadImport() {
  if (!isAdmin) {
    setMessage(importMessage, "Only admin can import leads.", true);
    return;
  }

  const file = leadImportFile.files?.[0];
  if (!file) {
    setMessage(importMessage, "Please select a .xlsx or .csv file.", true);
    return;
  }

  if (!/\.(xlsx|csv)$/i.test(file.name)) {
    setMessage(importMessage, "Unsupported format. Please upload .xlsx or .csv.", true);
    return;
  }

  const allocationValidation = validateAllocation(getAllocation());
  if (!allocationValidation.ok) {
    setMessage(importMessage, allocationValidation.message, true);
    return;
  }

  let rows = [];
  try {
    rows = await parseImportFile(file);
  } catch {
    setMessage(importMessage, "Could not read file. Check format and try again.", true);
    return;
  }

  if (!rows.length) {
    setMessage(importMessage, "No rows found in the uploaded file.", true);
    updateImportSummary(0, 0, 0);
    return;
  }

  const allLeads = getAllLeads();
  const existingEmails = new Set(allLeads.map((lead) => String(lead.email || "").toLowerCase()));

  const validLeads = [];
  const failed = [];
  let nextId = Math.max(...allLeads.map((lead) => Number(lead.id) || 0), 0) + 1;

  rows.forEach((row, idx) => {
    const { lead, error } = buildLeadFromImportRow(row, nextId);
    if (error) {
      failed.push(`Row ${idx + 2}: ${error}`);
      return;
    }

    if (existingEmails.has(lead.email)) {
      failed.push(`Row ${idx + 2}: Duplicate email ${lead.email}`);
      return;
    }

    existingEmails.add(lead.email);
    validLeads.push(lead);
    nextId += 1;
  });

  const assignments = createCounselorAssignments(validLeads.length, allocationValidation.cleaned);
  validLeads.forEach((lead, index) => {
    lead.counselor = assignments[index] || allocationValidation.cleaned[0].name;
  });

  const updatedLeads = [...allLeads, ...validLeads];
  normalizeLeadFields(updatedLeads);
  saveAllLeads(updatedLeads);

  updateImportSummary(rows.length, validLeads.length, failed.length);

  if (failed.length) {
    setMessage(importMessage, `Imported with ${failed.length} failures. Example: ${failed[0]}`, true);
  } else {
    setMessage(importMessage, `Imported ${validLeads.length} leads successfully.`, false);
  }

  leadImportFile.value = "";
  renderAll();
}

function setupAdminPanel() {
  if (!adminImportPanel) {
    return;
  }

  if (!isAdmin) {
    adminImportPanel.classList.add("hidden");
    return;
  }

  const hydrateAllocationPanel = async () => {
    let names = getActiveCounselorNames();
    if (!names.length) {
      names = await fetchCounselorNamesFromApi();
    }

    const existing = getAllocation();
    const merged = names.length ? mergeAllocationNames(names, existing) : existing;

    if (merged.length !== existing.length) {
      saveAllocation(merged);
    }

    if (!merged.length) {
      renderAllocationRows(syncAllocationWithCounselors());
      return;
    }

    renderAllocationRows(merged);
  };

  void hydrateAllocationPanel();

  addAllocationRowBtn.onclick = () => {
    const current = readAllocationFromForm();
    renderAllocationRows([...current, { name: "", percentage: 0 }]);
  };

  saveAllocationBtn.onclick = () => {
    const nextAllocation = readAllocationFromForm();
    const validation = validateAllocation(nextAllocation);

    if (!validation.ok) {
      setMessage(allocationMessage, validation.message, true);
      return;
    }

    saveAllocation(validation.cleaned);
    renderAllocationRows(validation.cleaned);
    setMessage(allocationMessage, "Counselor allocation saved successfully.", false);
  };

  importLeadsBtn.onclick = () => {
    handleLeadImport();
  };
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

function getPreWorkshopLeads(allLeads) {
  return allLeads.filter((lead) => !isPostWorkshopLead(lead) && !isLostLead(lead));
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

function getUniqueWorkshops(leads) {
  return [...new Set(leads.map((lead) => lead.workshop))];
}

function filterByTimeline(leads) {
  if (filter.timeline === "today") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return leads.filter((lead) => {
      const created = new Date(lead.createdAt);
      created.setHours(0, 0, 0, 0);
      return created.getTime() === today.getTime();
    });
  }

  if (filter.timeline === "yesterday") {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    return leads.filter((lead) => {
      const created = new Date(lead.createdAt);
      created.setHours(0, 0, 0, 0);
      return created.getTime() === yesterday.getTime();
    });
  }

  if (filter.timeline === "week") {
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const start = new Date();
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);

    return leads.filter((lead) => {
      const created = new Date(lead.createdAt);
      return created >= start && created <= end;
    });
  }

  if (filter.timeline === "custom") {
    if (!filter.startDate || !filter.endDate) {
      return leads;
    }

    const start = new Date(filter.startDate);
    start.setHours(0, 0, 0, 0);

    const end = new Date(filter.endDate);
    end.setHours(23, 59, 59, 999);

    return leads.filter((lead) => {
      const created = new Date(lead.createdAt);
      return created >= start && created <= end;
    });
  }

  return leads;
}

function filterLeads(leads) {
  let filtered = filterByTimeline(leads);

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

  if (filter.dialed !== "All") {
    filtered = filtered.filter((lead) => lead.dialed === filter.dialed);
  }

  if (filter.callStatus !== "All") {
    filtered = filtered.filter((lead) => lead.callStatus === filter.callStatus);
  }

  if (filter.wsStatus !== "All") {
    filtered = filtered.filter((lead) => lead.wsStatus === filter.wsStatus);
  }

  if (filter.whatsappInvite !== "All") {
    filtered = filtered.filter((lead) => lead.whatsappInvite === filter.whatsappInvite);
  }

  return filtered;
}

function renderKpis(leads) {
  const workshops = getUniqueWorkshops(leads);
  const overall = leads.length;

  let html = `
    <article class="card kpi-card">
      <p>Overall Leads</p>
      <h2>${overall}</h2>
    </article>
  `;

  workshops.forEach((workshop) => {
    const count = leads.filter((lead) => lead.workshop === workshop).length;
    html += `
      <article class="card kpi-card">
        <p>${workshop}</p>
        <h2>${count}</h2>
      </article>
    `;
  });

  preKpiSection.innerHTML = html;
}

function renderFilters(leads) {
  const workshops = getUniqueWorkshops(leads);
  const dialedOptions = getUniqueValues(leads, "dialed");
  const callStatusOptions = getUniqueValues(leads, "callStatus");
  const wsStatusOptions = getUniqueValues(leads, "wsStatus");
  const whatsappInviteOptions = getUniqueValues(leads, "whatsappInvite");

  preFilterBar.innerHTML = `
    <div class="filter-row">
      <div class="filter-item">
        <label for="timelineSelect">Timeline</label>
        <select id="timelineSelect">
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="week">Week</option>
          <option value="custom">Custom Range</option>
        </select>
      </div>

      <div class="filter-item hidden" id="startDateWrap">
        <label for="startDateInput">Start Date</label>
        <input id="startDateInput" type="date" />
      </div>

      <div class="filter-item hidden" id="endDateWrap">
        <label for="endDateInput">End Date</label>
        <input id="endDateInput" type="date" />
      </div>

      <div class="filter-item">
        <label for="searchLeadInput">Search Lead</label>
        <input id="searchLeadInput" type="text" placeholder="Name, email, phone, workshop, counselor" />
      </div>

      <div class="filter-item">
        <label for="workshopSelect">Workshop Name</label>
        <select id="workshopSelect">
          <option value="All">All</option>
          ${workshops.map((value) => `<option value="${value}">${value}</option>`).join("")}
        </select>
      </div>

      <div class="filter-item">
        <label for="dialedSelect">Dialed</label>
        <select id="dialedSelect">
          <option value="All">All</option>
          ${dialedOptions.map((value) => `<option value="${value}">${value}</option>`).join("")}
        </select>
      </div>

      <div class="filter-item">
        <label for="callStatusSelect">Call Status</label>
        <select id="callStatusSelect">
          <option value="All">All</option>
          ${callStatusOptions.map((value) => `<option value="${value}">${value}</option>`).join("")}
        </select>
      </div>

      <div class="filter-item">
        <label for="wsStatusSelect">Workshop Status</label>
        <select id="wsStatusSelect">
          <option value="All">All</option>
          ${wsStatusOptions.map((value) => `<option value="${value}">${value}</option>`).join("")}
        </select>
      </div>

      <div class="filter-item">
        <label for="whatsappInviteSelect">WhatsApp Invitation Sent</label>
        <select id="whatsappInviteSelect">
          <option value="All">All</option>
          ${whatsappInviteOptions.map((value) => `<option value="${value}">${value}</option>`).join("")}
        </select>
      </div>

      <div class="filter-item filter-item-cta">
        <label>&nbsp;</label>
        <div class="filter-actions">
          <button id="applyFilters" class="btn-ghost" type="button">Apply</button>
          <button id="resetFilters" class="btn-ghost" type="button">Reset</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("timelineSelect").value = filter.timeline;
  document.getElementById("startDateInput").value = filter.startDate;
  document.getElementById("endDateInput").value = filter.endDate;
  document.getElementById("searchLeadInput").value = filter.search;
  document.getElementById("workshopSelect").value = filter.workshop;
  document.getElementById("dialedSelect").value = filter.dialed;
  document.getElementById("callStatusSelect").value = filter.callStatus;
  document.getElementById("wsStatusSelect").value = filter.wsStatus;
  document.getElementById("whatsappInviteSelect").value = filter.whatsappInvite;

  document.getElementById("startDateWrap").classList.toggle("hidden", filter.timeline !== "custom");
  document.getElementById("endDateWrap").classList.toggle("hidden", filter.timeline !== "custom");

  document.getElementById("timelineSelect").onchange = (event) => {
    filter.timeline = event.target.value;
    document.getElementById("startDateWrap").classList.toggle("hidden", filter.timeline !== "custom");
    document.getElementById("endDateWrap").classList.toggle("hidden", filter.timeline !== "custom");
  };

  document.getElementById("startDateInput").onchange = (event) => {
    filter.startDate = event.target.value;
  };

  document.getElementById("endDateInput").onchange = (event) => {
    filter.endDate = event.target.value;
  };

  document.getElementById("searchLeadInput").oninput = (event) => {
    filter.search = event.target.value.trim();
  };

  document.getElementById("workshopSelect").onchange = (event) => {
    filter.workshop = event.target.value;
  };

  document.getElementById("dialedSelect").onchange = (event) => {
    filter.dialed = event.target.value;
  };

  document.getElementById("callStatusSelect").onchange = (event) => {
    filter.callStatus = event.target.value;
  };

  document.getElementById("wsStatusSelect").onchange = (event) => {
    filter.wsStatus = event.target.value;
  };

  document.getElementById("whatsappInviteSelect").onchange = (event) => {
    filter.whatsappInvite = event.target.value;
  };

  document.getElementById("applyFilters").onclick = () => {
    renderAll();
  };

  document.getElementById("resetFilters").onclick = () => {
    filter = { ...DEFAULT_FILTER };
    renderAll();
  };
}

function renderActivityStatusPanel(lead) {
  return `
    <div class="activity-panel">
      <span class="status-summary">${lead.dialed}, ${lead.callStatus}, ${lead.wsStatus}, WA Invite: ${lead.whatsappInvite}</span>
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
            <th>Counselor</th>
            <th>Activity Status</th>
          </tr>
        </thead>
        <tbody>
  `;

  if (!leads.length) {
    html += `<tr><td colspan="7">No leads found for current filters.</td></tr>`;
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
        <td>${lead.counselor || "Unassigned"}</td>
        <td>${renderActivityStatusPanel(lead)}</td>
      </tr>
    `
      )
      .join("");
  }

  html += `</tbody></table></div>`;
  preLeadTableSection.innerHTML = html;

  document.querySelectorAll(".btn-update-status").forEach((button) => {
    button.onclick = () => {
      const leadId = button.getAttribute("data-lead-id");
      openActivityStatusModal(leadId);
    };
  });
}

function updateLeadActivity(leadId, updates) {
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
    preActivityUpdates: (Number(allLeads[index].preActivityUpdates) || 0) + 1
  };

  saveAllLeads(allLeads);
}

function openActivityStatusModal(leadId) {
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

  document.getElementById("modalDialed").value = lead.dialed;
  document.getElementById("modalCallStatus").value = lead.callStatus;
  document.getElementById("modalWsStatus").value = lead.wsStatus;
  document.getElementById("modalWhatsappInvite").value = lead.whatsappInvite;
  document.getElementById("activityStatusModal").classList.remove("hidden");
}

function closeActivityStatusModal() {
  document.getElementById("activityStatusModal").classList.add("hidden");
  modalLeadId = null;
}

window.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("activityStatusModal");
  if (modal) {
    document.getElementById("closeModalBtn").onclick = closeActivityStatusModal;
    document.getElementById("activityStatusForm").onsubmit = (event) => {
      event.preventDefault();
      if (!modalLeadId) {
        return;
      }

      updateLeadActivity(modalLeadId, {
        dialed: document.getElementById("modalDialed").value,
        callStatus: document.getElementById("modalCallStatus").value,
        wsStatus: document.getElementById("modalWsStatus").value,
        whatsappInvite: document.getElementById("modalWhatsappInvite").value
      });

      closeActivityStatusModal();
      renderAll();
    };
  }

  setupAdminPanel();
});

function renderAll() {
  const allLeads = getAllLeads();
  normalizeLeadFields(allLeads);
  saveAllLeads(allLeads);

  const scopedLeads = getScopedLeads(allLeads);
  const preWorkshopLeads = getPreWorkshopLeads(scopedLeads);
  const filteredLeads = filterLeads(preWorkshopLeads);

  renderKpis(filteredLeads);
  renderFilters(preWorkshopLeads);
  renderLeadTable(filteredLeads);
}

renderAll();
