import { bootstrapLocalState, loadPersistedValue, savePersistedValue, syncStateFromLocal } from "./state-sync.js";
import { createTask, TASK_CATEGORY } from "./task-service.js";

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
const saveAllocationBtn = document.getElementById("saveAllocationBtn");
const allocationMessage = document.getElementById("allocationMessage");
const deleteAllLeadsBtn = document.getElementById("deleteAllLeadsBtn");
const deleteLostLeadsBtn = document.getElementById("deleteLostLeadsBtn");
const cleanupMessage = document.getElementById("cleanupMessage");
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

const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
const isAdmin = session?.role === "admin";
const canCreateTasks = session?.role === "counselor";

function extractCounselorName(record) {
  return String(
    record?.name
      ?? record?.counselorName
      ?? record?.fullName
      ?? record?.displayName
      ?? ""
  ).trim();
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    return { response, json: response.ok ? await response.json() : null };
  } finally {
    clearTimeout(timeoutId);
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

const DEFAULT_FILTER = {
  timeline: "week",
  startDate: "",
  endDate: "",
  search: "",
  counselor: "All",
  activityStatus: "All",
  workshop: "All",
  dialed: "All",
  callStatus: "All",
  wsStatus: "All",
  whatsappInvite: "All"
};

const FILTER_STORAGE_KEY = "dvWorkshopWorkshopCallingFilters";
let filter = {
  ...DEFAULT_FILTER,
  ...loadPersistedValue(FILTER_STORAGE_KEY, {})
};

const DEFAULT_ALLOCATION = [];

let modalLeadId = null;
let modalMode = "edit";
let selectedLeadIds = new Set();

const activityFields = ["modalDialed", "modalCallStatus", "modalWsStatus", "modalWhatsappInvite"];

function toIsoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function setMessage(element, text, isError = true) {
  element.textContent = text;
  element.style.color = isError ? "#b42318" : "#0f766e";
}

function persistFilterState() {
  savePersistedValue(FILTER_STORAGE_KEY, filter);
}

function normalizeFilterState(leads) {
  const workshops = getUniqueWorkshops(leads);
  const validWorkshop = filter.workshop === "All" || workshops.includes(filter.workshop);

  const nextFilter = {
    ...filter,
    workshop: validWorkshop ? (filter.workshop || "All") : "All",
    dialed: filter.dialed || "All",
    callStatus: filter.callStatus || "All",
    wsStatus: filter.wsStatus || "All",
    whatsappInvite: filter.whatsappInvite || "All"
  };

  const changed = Object.keys(nextFilter).some((key) => nextFilter[key] !== filter[key]);
  if (changed) {
    filter = nextFilter;
    persistFilterState();
  }
}

function getDefaultWsStatus(lead) {
  const status = String(lead?.status || "").trim();
  if (status === "Interested" || status === "Converted") {
    return "Interested";
  }

  // New/unspecified leads should not be marked lost by default.
  return "Interested";
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
    lead.workshop = lead.workshop || "";
    lead.createdAt = lead.createdAt || toIsoDate();

    lead.status = lead.status || "New";
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

function deleteWholeLeadDataset() {
  const confirmed = window.confirm("Delete the entire lead dataset? This cannot be undone.");
  if (!confirmed) {
    return;
  }

  saveAllLeads([]);
  setMessage(cleanupMessage, "Whole lead dataset deleted successfully.", false);
  renderAll();
}

function deleteLostLeads() {
  const allLeads = getAllLeads();
  const retainedLeads = allLeads.filter((lead) => !isLostLead(lead));
  const removedCount = allLeads.length - retainedLeads.length;

  if (!removedCount) {
    setMessage(cleanupMessage, "No lost leads found to delete.", false);
    return;
  }

  const confirmed = window.confirm(`Delete ${removedCount} lost lead${removedCount === 1 ? "" : "s"}? This cannot be undone.`);
  if (!confirmed) {
    return;
  }

  normalizeLeadFields(retainedLeads);
  saveAllLeads(retainedLeads);
  setMessage(cleanupMessage, `${removedCount} lost lead${removedCount === 1 ? "" : "s"} deleted successfully.`, false);
  renderAll();
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

async function getCounselorNamesForAllocation() {
  const localRaw = localStorage.getItem(COUNSELORS_KEY);
  if (localRaw) {
    try {
      const localCounselors = JSON.parse(localRaw);
      if (Array.isArray(localCounselors) && localCounselors.length) {
        return [...new Set(
          localCounselors
            .map((item) => extractCounselorName(item))
            .filter(Boolean)
        )];
      }
    } catch {
      // Continue with API fallback.
    }
  }

  try {
    const { response, json } = await fetchJsonWithTimeout("/api/state", {
      method: "GET",
      headers: { Accept: "application/json" }
    }, 4000);

    if (!response.ok) {
      return [];
    }

    const payload = json;
    const counselors = Array.isArray(payload?.counselors) ? payload.counselors : [];

    localStorage.setItem(COUNSELORS_KEY, JSON.stringify(counselors));

    return [...new Set(
      counselors
        .map((item) => extractCounselorName(item))
        .filter(Boolean)
    )];
  } catch {
    return [];
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
      <p class="block-help">No counselors found yet. Add counselors in Counselor Management.</p>
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

function appendAllocationRow() {
  const current = readAllocationFromForm();
  const nonEmpty = current.filter((item) => String(item.name || "").trim());
  const nextNumber = nonEmpty.length + 1;

  renderAllocationRows([
    ...current,
    { name: `Counselor ${nextNumber}`, percentage: 0 }
  ]);
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
  const entries = Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]);
  const normalizedAliases = aliases.map((alias) => normalizeHeader(alias));

  for (const alias of normalizedAliases) {
    const exactMatch = entries.find(([key]) => key === alias);
    if (exactMatch && String(exactMatch[1]).trim() !== "") {
      return exactMatch[1];
    }
  }

  for (const alias of normalizedAliases) {
    const partialMatch = entries.find(([key]) => key.includes(alias) || alias.includes(key));
    if (partialMatch && String(partialMatch[1]).trim() !== "") {
      return partialMatch[1];
    }
  }

  return "";
}

function normalizeCreatedAt(value) {
  if (!value) {
    return toIsoDate();
  }

  const trimmedValue = String(value).trim();
  const serialValue = Number(value);
  const looksLikeSerial = trimmedValue !== "" && /^\d+(\.\d+)?$/.test(trimmedValue) && Number.isFinite(serialValue);

  if ((typeof value === "number" || looksLikeSerial) && typeof XLSX !== "undefined" && XLSX.SSF?.parse_date_code) {
    const parsed = XLSX.SSF.parse_date_code(serialValue);
    if (parsed) {
      const date = new Date(parsed.y, parsed.m - 1, parsed.d);
      if (!Number.isNaN(date.getTime())) {
        return toIsoDate(date);
      }
    }
  }

  const asDate = new Date(value);
  if (!Number.isNaN(asDate.getTime())) {
    return toIsoDate(asDate);
  }

  return toIsoDate();
}

function buildLeadFromImportRow(row, id, workshopName) {
  const name = String(pickValue(row, ["studentname", "fullname", "leadname", "name"])).trim();
  const email = String(pickValue(row, ["emailaddress", "emailid", "mail", "email"])).trim().toLowerCase();
  const workshop = String(workshopName || "").trim();

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
    phone: String(pickValue(row, ["phone", "phonenumber", "number", "mobile", "contact"]))
      .trim(),
    workshop,
    status: String(pickValue(row, ["status"])) || "New",
    createdAt: toIsoDate(),
    dialed: "",
    callStatus: "",
    wsStatus: "",
    whatsappInvite: "",
    counselor: "Unassigned",
    postDialed: "",
    coursePitched: "",
    courseStatus: "",
    admissionStatus: "",
    postStatusUpdated: false,
    preActivityUpdates: 0,
    postActivityUpdates: 0,
    workshopActivityHistory: [],
    admissionActivityHistory: []
  };

  return { lead };
}

function mergeImportedLead(existingLead, importedLead) {
  const preservedWorkshopHistory = Array.isArray(existingLead.workshopActivityHistory)
    ? existingLead.workshopActivityHistory
    : [];
  const preservedAdmissionHistory = Array.isArray(existingLead.admissionActivityHistory)
    ? existingLead.admissionActivityHistory
    : [];

  return {
    ...existingLead,
    ...importedLead,
    id: existingLead.id,
    counselor: existingLead.counselor || importedLead.counselor || "Unassigned",
    workshopActivityHistory: preservedWorkshopHistory,
    admissionActivityHistory: preservedAdmissionHistory,
    preActivityUpdates: preservedWorkshopHistory.length,
    postActivityUpdates: preservedAdmissionHistory.length,
    postStatusUpdated: typeof existingLead.postStatusUpdated === "boolean" ? existingLead.postStatusUpdated : false
  };
}

async function parseImportFile(file) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetNames = workbook.SheetNames || [];
  if (!sheetNames.length) {
    return [];
  }

  return sheetNames.flatMap((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      return [];
    }

    return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false }).map((row) => ({
      ...row,
      __workshopName: sheetName
    }));
  });
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

  const nextLeads = getAllLeads();
  const leadIndexByEmail = new Map(
    nextLeads.map((lead, index) => [String(lead.email || "").toLowerCase(), index])
  );

  const importedRecords = [];
  const failed = [];
  let createdCount = 0;
  let updatedCount = 0;
  let nextId = Math.max(...nextLeads.map((lead) => Number(lead.id) || 0), 0) + 1;

  rows.forEach((row, idx) => {
    const { lead, error } = buildLeadFromImportRow(row, nextId, row.__workshopName);
    if (error) {
      failed.push(`Row ${idx + 2}: ${error}`);
      return;
    }

    const existingIndex = leadIndexByEmail.get(lead.email);
    if (existingIndex !== undefined) {
      nextLeads[existingIndex] = mergeImportedLead(nextLeads[existingIndex], lead);
      importedRecords.push({ index: existingIndex, lead: nextLeads[existingIndex] });
      updatedCount += 1;
      return;
    }

    nextLeads.push(lead);
    importedRecords.push({ index: nextLeads.length - 1, lead });
    leadIndexByEmail.set(lead.email, nextLeads.length - 1);
    createdCount += 1;
    nextId += 1;
  });

  const recordsNeedingAssignment = importedRecords.filter(({ lead }) => {
    const counselor = String(lead.counselor || "").trim().toLowerCase();
    return !counselor || counselor === "unassigned";
  });

  const assignments = createCounselorAssignments(recordsNeedingAssignment.length, allocationValidation.cleaned);
  recordsNeedingAssignment.forEach((record, index) => {
    const assignedCounselor = assignments[index] || allocationValidation.cleaned[0].name;
    record.lead.counselor = assignedCounselor;
    nextLeads[record.index] = record.lead;
  });

  normalizeLeadFields(nextLeads);
  saveAllLeads(nextLeads);
  await syncStateFromLocal();

  updateImportSummary(rows.length, importedRecords.length, failed.length);

  if (failed.length) {
    setMessage(importMessage, `Imported with ${failed.length} failures. Example: ${failed[0]}`, true);
  } else {
    const messageParts = [];
    if (createdCount) {
      messageParts.push(`created ${createdCount}`);
    }
    if (updatedCount) {
      messageParts.push(`updated ${updatedCount}`);
    }
    setMessage(importMessage, `Import completed: ${messageParts.join(" and ") || "no changes"}.`, false);
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
    const names = await getCounselorNamesForAllocation();
    const existing = getAllocation();
    const merged = mergeAllocationNames(names, existing);

    saveAllocation(merged);

    if (!merged.length) {
      renderAllocationRows([]);
      return;
    }

    renderAllocationRows(merged);
  };

  void hydrateAllocationPanel();

  if (!saveAllocationBtn) {
    return;
  }

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

  if (deleteAllLeadsBtn) {
    deleteAllLeadsBtn.addEventListener("click", deleteWholeLeadDataset);
  }

  if (deleteLostLeadsBtn) {
    deleteLostLeadsBtn.addEventListener("click", deleteLostLeads);
  }
}

function isPostWorkshopLead(lead) {
  return lead.wsStatus === "Interested" && lead.whatsappInvite === "Yes";
}

function isLostLead(lead) {
  return lead.wsStatus === "Not Interested" || (lead.postStatusUpdated && lead.courseStatus === "Not Interested");
}

function getPreWorkshopLeads(allLeads) {
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

function getUniqueWorkshops(leads) {
  return [...new Set(leads.map((lead) => lead.workshop))];
}

function filterByTimeline(leads) {
  if (filter.timeline === "overall") {
    return leads;
  }

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

  if (filter.counselor !== "All") {
    filtered = filtered.filter((lead) => String(lead.counselor || "").trim() === filter.counselor);
  }

  if (filter.activityStatus === "Untouched") {
    filtered = filtered.filter((lead) => isUntouchedLead(lead));
  }

  if (filter.activityStatus === "Updated") {
    filtered = filtered.filter((lead) => !isUntouchedLead(lead));
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
  const counselorOptions = getActiveCounselorNames();
  const dialedOptions = getUniqueValues(leads, "dialed");
  const callStatusOptions = getUniqueValues(leads, "callStatus");
  const wsStatusOptions = getUniqueValues(leads, "wsStatus");
  const whatsappInviteOptions = getUniqueValues(leads, "whatsappInvite");

  preFilterBar.innerHTML = `
    <div class="filter-row">
      <div class="filter-item">
        <label for="timelineSelect">Timeline</label>
        <select id="timelineSelect">
          <option value="overall">Overall</option>
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

      <div class="filter-item${isAdmin ? "" : " hidden"}" data-admin-only="true">
        <label for="counselorSelect">Counselor</label>
        <select id="counselorSelect">
          <option value="All">All</option>
          ${counselorOptions.map((value) => `<option value="${value}">${value}</option>`).join("")}
        </select>
      </div>

      <div class="filter-item">
        <label for="activityStatusSelect">Untouched Leads</label>
        <select id="activityStatusSelect">
          <option value="All">All</option>
          <option value="Untouched">Untouched Only</option>
          <option value="Updated">Updated Only</option>
        </select>
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
  document.getElementById("counselorSelect").value = filter.counselor;
  document.getElementById("activityStatusSelect").value = filter.activityStatus;
  document.getElementById("workshopSelect").value = filter.workshop;
  document.getElementById("dialedSelect").value = filter.dialed;
  document.getElementById("callStatusSelect").value = filter.callStatus;
  document.getElementById("wsStatusSelect").value = filter.wsStatus;
  document.getElementById("whatsappInviteSelect").value = filter.whatsappInvite;

  document.getElementById("startDateWrap").classList.toggle("hidden", filter.timeline !== "custom");
  document.getElementById("endDateWrap").classList.toggle("hidden", filter.timeline !== "custom");

  document.getElementById("timelineSelect").onchange = (event) => {
    filter.timeline = event.target.value;
    persistFilterState();
    document.getElementById("startDateWrap").classList.toggle("hidden", filter.timeline !== "custom");
    document.getElementById("endDateWrap").classList.toggle("hidden", filter.timeline !== "custom");
  };

  document.getElementById("startDateInput").onchange = (event) => {
    filter.startDate = event.target.value;
    persistFilterState();
  };

  document.getElementById("endDateInput").onchange = (event) => {
    filter.endDate = event.target.value;
    persistFilterState();
  };

  document.getElementById("searchLeadInput").oninput = (event) => {
    filter.search = event.target.value.trim();
    persistFilterState();
  };

  document.getElementById("counselorSelect").onchange = (event) => {
    filter.counselor = event.target.value;
    persistFilterState();
  };

  document.getElementById("activityStatusSelect").onchange = (event) => {
    filter.activityStatus = event.target.value;
    persistFilterState();
  };

  document.getElementById("workshopSelect").onchange = (event) => {
    filter.workshop = event.target.value;
    persistFilterState();
  };

  document.getElementById("dialedSelect").onchange = (event) => {
    filter.dialed = event.target.value;
    persistFilterState();
  };

  document.getElementById("callStatusSelect").onchange = (event) => {
    filter.callStatus = event.target.value;
    persistFilterState();
  };

  document.getElementById("wsStatusSelect").onchange = (event) => {
    filter.wsStatus = event.target.value;
    persistFilterState();
  };

  document.getElementById("whatsappInviteSelect").onchange = (event) => {
    filter.whatsappInvite = event.target.value;
    persistFilterState();
  };

  document.getElementById("applyFilters").onclick = () => {
    renderAll();
  };

  document.getElementById("resetFilters").onclick = () => {
    filter = { ...DEFAULT_FILTER };
    persistFilterState();
    renderAll();
  };
}

function renderActivityStatusPanel(lead) {
  return `
    <div class="activity-panel">
      <button class="btn-view-activity" type="button" data-lead-id="${lead.id}" aria-label="View activity details" title="View activity details">👁</button>
      <button class="btn-update-status" data-lead-id="${lead.id}">Update</button>
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
                <input id="preBulkSelect" type="checkbox" ${allSelected ? "checked" : ""} />
                <span>Select All</span>
              </label>
              <div class="bulk-select-actions">
                <span class="selected-count">Selected: ${selectedCount}</span>
                <button id="preBulkDelete" class="btn-delete bulk-delete-btn" type="button" ${selectedCount ? "" : "disabled"}>Delete Selected</button>
              </div>
            </th>
    `
    : "";
  const emptyColspan = isAdmin ? 8 : 7;

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
            <th>Counselor</th>
            <th>Activity Status</th>
          </tr>
        </thead>
        <tbody>
  `;

  if (!leads.length) {
    html += `<tr><td colspan="${emptyColspan}">No leads found for current filters.</td></tr>`;
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
        <td>${lead.counselor || "Unassigned"}</td>
        <td>${renderActivityStatusPanel(lead)}</td>
      </tr>
    `
      )
      .join("");
  }

  html += `</tbody></table></div>`;
  preLeadTableSection.innerHTML = html;

  document.querySelectorAll(".btn-view-activity").forEach((button) => {
    button.onclick = () => {
      const leadId = button.getAttribute("data-lead-id");
      openActivityDetailsModal(leadId);
    };
  });

  document.querySelectorAll(".btn-update-status").forEach((button) => {
    button.onclick = () => {
      const leadId = button.getAttribute("data-lead-id");
      openActivityStatusModal(leadId);
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

  const bulkSelect = document.getElementById("preBulkSelect");
  if (bulkSelect) {
    bulkSelect.onchange = (event) => {
      toggleAllLeadsSelection(leads, event.target.checked);
      renderAll();
    };
  }

  const bulkDelete = document.getElementById("preBulkDelete");
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

function setActivityModalMode(mode) {
  modalMode = mode;
  const title = document.getElementById("activityModalTitle");
  const saveButton = document.getElementById("saveActivityBtn");

  if (title) {
    title.textContent = mode === "view" ? "Activity Details" : "Update Activity Status";
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

function populateActivityModal(lead) {
  document.getElementById("modalDialed").value = lead.dialed;
  document.getElementById("modalCallStatus").value = lead.callStatus;
  document.getElementById("modalWsStatus").value = lead.wsStatus;
  document.getElementById("modalWhatsappInvite").value = lead.whatsappInvite;
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

  const workshopHistory = Array.isArray(allLeads[index].workshopActivityHistory)
    ? allLeads[index].workshopActivityHistory
    : [];
  const nextWorkshopHistory = [
    ...workshopHistory,
    {
      at: new Date().toISOString(),
      source: "Workshop Calling",
      updates
    }
  ];

  allLeads[index] = {
    ...allLeads[index],
    ...updates,
    workshopActivityHistory: nextWorkshopHistory,
    preActivityUpdates: nextWorkshopHistory.length
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

  setActivityModalMode("edit");
  populateActivityModal(lead);
  document.getElementById("activityStatusModal").classList.remove("hidden");
}

function openActivityDetailsModal(leadId) {
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

  setActivityModalMode("view");
  populateActivityModal(lead);
  document.getElementById("activityStatusModal").classList.remove("hidden");
}

function closeActivityStatusModal() {
  document.getElementById("activityStatusModal").classList.add("hidden");
  modalLeadId = null;
  setActivityModalMode("edit");
}

function setTaskMessage(text, isError = true) {
  if (!taskMessage) {
    return;
  }

  taskMessage.textContent = text;
  taskMessage.style.color = isError ? "#b42318" : "#0f766e";
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
  taskCategoryInput.value = TASK_CATEGORY.workshop;
  taskLeadNameInput.value = lead.name || "";
  taskCounselorInput.value = lead.counselor || "Unassigned";
  taskTitleInput.value = `Follow up with ${lead.name || "lead"}`;
  taskNotesInput.value = "";
  taskDueDateInput.value = "";
  setTaskMessage("");
  taskModalTitle.textContent = "Create Workshop Task";
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
    category: TASK_CATEGORY.workshop,
    title,
    notes: taskNotesInput.value.trim(),
    dueDate
  });

  setTaskMessage("Task created and sent to Task Tracker.", false);
  closeTaskModal();
}

function initPreWorkshopPage() {
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

  setupAdminPanel();
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initPreWorkshopPage);
} else {
  initPreWorkshopPage();
}

function renderAll() {
  const allLeads = getAllLeads();
  normalizeLeadFields(allLeads);
  saveAllLeads(allLeads);

  const scopedLeads = getScopedLeads(allLeads);
  const preWorkshopLeads = getPreWorkshopLeads(scopedLeads);
  normalizeFilterState(preWorkshopLeads);
  const filteredLeads = filterLeads(preWorkshopLeads);

  renderKpis(filteredLeads);
  renderFilters(preWorkshopLeads);
  renderLeadTable(filteredLeads);
}

renderAll();
