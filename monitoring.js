import { registerPageCleanup } from "./page-runtime.js";
import { bootstrapLocalState, getCounselors, getLeads as getStoredLeads, getSession, loadPersistedValue, savePersistedValue, startStatePolling } from "./state-sync.js";

await bootstrapLocalState();

const monitoringKpiSection = document.getElementById("monitoringKpiSection");
const preMonitoringTable = document.getElementById("preMonitoringTable");
const postMonitoringTable = document.getElementById("postMonitoringTable");

const monitoringTimelineSelect = document.getElementById("monitoringTimelineSelect");
const monitoringStartDate = document.getElementById("monitoringStartDate");
const monitoringEndDate = document.getElementById("monitoringEndDate");
const monitoringStartDateWrap = document.getElementById("monitoringStartDateWrap");
const monitoringEndDateWrap = document.getElementById("monitoringEndDateWrap");
const resetMonitoringTimeline = document.getElementById("resetMonitoringTimeline");
const exportMonitoringBtn = document.getElementById("exportMonitoringBtn");
const monitoringExportMessage = document.getElementById("monitoringExportMessage");

const session = getSession();

let timelineFilter = {
  type: "week",
  startDate: "",
  endDate: ""
};

const TIMELINE_STORAGE_KEY = "dvWorkshopMonitoringTimeline";

timelineFilter = {
  ...timelineFilter,
  ...await loadPersistedValue(TIMELINE_STORAGE_KEY, {})
};

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

function persistTimelineFilter() {
  void savePersistedValue(TIMELINE_STORAGE_KEY, timelineFilter);
}

function setExportMessage(text, isError = true) {
  if (!monitoringExportMessage) {
    return;
  }

  monitoringExportMessage.textContent = text;
  monitoringExportMessage.style.color = isError ? "var(--danger)" : "var(--success)";
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
    lead.preActivityUpdates = lead.workshopActivityHistory.length > 0 ? 1 : 0;
    lead.postActivityUpdates = lead.admissionActivityHistory.length > 0 ? 1 : 0;
  });
}

function getAllLeads() {
  const leads = getStoredLeads();
  normalizeLeadFields(leads);
  return leads;
}

function getTimelineRange() {
  if (timelineFilter.type === "overall") {
    return null;
  }

  const now = new Date();

  if (timelineFilter.type === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  if (timelineFilter.type === "yesterday") {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    const start = new Date(d);
    start.setHours(0, 0, 0, 0);
    const end = new Date(d);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  if (timelineFilter.type === "week") {
    const start = new Date(now);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  if (timelineFilter.type === "custom") {
    if (!timelineFilter.startDate || !timelineFilter.endDate) {
      return null;
    }

    const start = new Date(timelineFilter.startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(timelineFilter.endDate);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  return null;
}

function applyTimelineFilter(leads) {
  const range = getTimelineRange();

  // "overall" — return all leads with their full activity counts unchanged
  if (!range) {
    return leads;
  }

  const { start, end } = range;

  return leads
    .map((lead) => {
      const workshopHistory = Array.isArray(lead.workshopActivityHistory) ? lead.workshopActivityHistory : [];
      const admissionHistory = Array.isArray(lead.admissionActivityHistory) ? lead.admissionActivityHistory : [];

      const workshopInRange = workshopHistory.filter((entry) => {
        const d = new Date(entry.at);
        return d >= start && d <= end;
      });
      const admissionInRange = admissionHistory.filter((entry) => {
        const d = new Date(entry.at);
        return d >= start && d <= end;
      });

      return {
        ...lead,
        preActivityUpdates: workshopInRange.length > 0 ? 1 : 0,
        postActivityUpdates: admissionInRange.length > 0 ? 1 : 0
      };
    })
    .filter((lead) => lead.preActivityUpdates > 0 || lead.postActivityUpdates > 0);
}

function bindTimelineControls() {
  monitoringTimelineSelect.value = timelineFilter.type;
  monitoringStartDate.value = timelineFilter.startDate;
  monitoringEndDate.value = timelineFilter.endDate;

  monitoringStartDateWrap.classList.toggle("hidden", timelineFilter.type !== "custom");
  monitoringEndDateWrap.classList.toggle("hidden", timelineFilter.type !== "custom");

  monitoringTimelineSelect.onchange = (event) => {
    timelineFilter.type = event.target.value;
    persistTimelineFilter();
    monitoringStartDateWrap.classList.toggle("hidden", timelineFilter.type !== "custom");
    monitoringEndDateWrap.classList.toggle("hidden", timelineFilter.type !== "custom");
    renderAll();
  };

  monitoringStartDate.onchange = (event) => {
    timelineFilter.startDate = event.target.value;
    persistTimelineFilter();
    renderAll();
  };

  monitoringEndDate.onchange = (event) => {
    timelineFilter.endDate = event.target.value;
    persistTimelineFilter();
    renderAll();
  };

  resetMonitoringTimeline.onclick = () => {
    timelineFilter = {
      type: "week",
      startDate: "",
      endDate: ""
    };
    persistTimelineFilter();
    bindTimelineControls();
    renderAll();
  };
}

function isPostWorkshopLead(lead) {
  return lead.wsStatus === "Interested" && lead.whatsappInvite === "Yes";
}

function isLostLead(lead) {
  return lead.wsStatus === "Not Interested" || (lead.postStatusUpdated && lead.courseStatus === "Not Interested");
}

function getPreLeads(allLeads) {
  return allLeads.filter((lead) => !isLostLead(lead));
}

function getPostLeads(allLeads) {
  return allLeads.filter((lead) => !isLostLead(lead));
}

function formatBreakdown(items, key, options = {}) {
  const { exclude = [] } = options;
  const counts = new Map();

  items.forEach((item) => {
    const value = String(item[key] || "").trim();
    if (!value || exclude.includes(value)) {
      return;
    }

    counts.set(value, (counts.get(value) || 0) + 1);
  });

  if (!counts.size) {
    return "-";
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");
}

function getCounselorBuckets(allLeads) {
  const names = [...new Set(allLeads.map((lead) => lead.counselor || "Unassigned"))]
    .filter((name) => name && name.trim())
    .sort((a, b) => a.localeCompare(b));

  return names.length ? names : ["Unassigned"];
}

function buildRows(counselors, stageLeads, activityKey, statusKey) {
  return counselors.map((counselor) => {
    const leads = stageLeads.filter((lead) => (lead.counselor || "Unassigned") === counselor);
    const activityLeads = leads.filter((lead) => (Number(lead[activityKey]) || 0) > 0);
    const activities = activityLeads.reduce((sum, lead) => sum + (Number(lead[activityKey]) || 0), 0);
    const interested = activityLeads.filter((lead) => lead[statusKey] === "Interested").length;
    const notInterested = activityLeads.filter((lead) => lead[statusKey] === "Not Interested").length;
    const enrolled = activityLeads.filter((lead) => lead.admissionStatus === "Enrolled").length;
    const won = activityLeads.filter((lead) => lead.admissionStatus === "Won").length;

    return {
      counselor,
      activities,
      workshops: formatBreakdown(activityLeads, "workshop"),
      interested,
      notInterested,
      enrolled,
      won
    };
  });
}

function renderMonitoringTable(container, rows) {
  const html = `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Counselor Name</th>
            <th>Total Activities Completed</th>
            <th>Workshop-wise Activity Breakdown</th>
            <th>Interested Leads</th>
            <th>Not Interested Leads</th>
            <th>Enrolled</th>
            <th>Won</th>
          </tr>
        </thead>
        <tbody>
          ${
            rows.length
              ? rows
                  .map(
                    (row) => `
                    <tr>
                      <td>${row.counselor}</td>
                      <td>${row.activities}</td>
                      <td>${row.workshops}</td>
                      <td>${row.interested}</td>
                      <td>${row.notInterested}</td>
                      <td>${row.enrolled}</td>
                      <td>${row.won}</td>
                    </tr>
                  `
                  )
                  .join("")
              : `<tr><td colspan="7">No monitoring data available.</td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;

  container.innerHTML = html;
}

function getTimelineLabel() {
  if (timelineFilter.type === "overall") {
    return "Overall";
  }

  if (timelineFilter.type === "today") {
    return "Today";
  }

  if (timelineFilter.type === "yesterday") {
    return "Yesterday";
  }

  if (timelineFilter.type === "week") {
    return "Week";
  }

  if (timelineFilter.type === "custom") {
    if (!timelineFilter.startDate || !timelineFilter.endDate) {
      return "Custom Range";
    }

    return `${timelineFilter.startDate} to ${timelineFilter.endDate}`;
  }

  return "Monitoring Report";
}

function getVisibleKpiSnapshot() {
  return Array.from(monitoringKpiSection.querySelectorAll(".kpi-card")).map((card) => ({
    Metric: card.querySelector("p")?.textContent?.trim() || "",
    Value: card.querySelector("h2")?.textContent?.trim() || ""
  }));
}

function getVisibleTableSnapshot(container) {
  const table = container?.querySelector("table");
  if (!table) {
    return { headers: [], rows: [] };
  }

  const headers = Array.from(table.querySelectorAll("thead th"))
    .map((header) => header.textContent.trim())
    .filter(Boolean);

  const rows = Array.from(table.querySelectorAll("tbody tr")).map((row) =>
    Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent.trim())
  );

  return { headers, rows };
}

function exportMonitoringExcel() {
  if (typeof XLSX === "undefined") {
    setExportMessage("Excel export is unavailable because the spreadsheet library did not load.", true);
    return;
  }

  const workbook = XLSX.utils.book_new();
  const summaryRows = [
    { Metric: "Timeline", Value: getTimelineLabel() },
    ...getVisibleKpiSnapshot()
  ];

  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");

  const workshopTable = getVisibleTableSnapshot(preMonitoringTable);
  const workshopSheet = XLSX.utils.aoa_to_sheet([workshopTable.headers, ...workshopTable.rows]);
  XLSX.utils.book_append_sheet(workbook, workshopSheet, "Workshop Monitoring");

  const admissionTable = getVisibleTableSnapshot(postMonitoringTable);
  const admissionSheet = XLSX.utils.aoa_to_sheet([admissionTable.headers, ...admissionTable.rows]);
  XLSX.utils.book_append_sheet(workbook, admissionSheet, "Admission Monitoring");

  const fileName = `monitoring-report-${timelineFilter.type}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(workbook, fileName);
  setExportMessage("Excel report exported successfully.", false);
}

function renderKpis(allLeads, preLeads, postLeads) {
  const preActivity = preLeads.reduce((sum, lead) => sum + (Number(lead.preActivityUpdates) || 0), 0);
  const postActivity = postLeads.reduce((sum, lead) => sum + (Number(lead.postActivityUpdates) || 0), 0);
  const overallActivity = preActivity + postActivity;

  monitoringKpiSection.innerHTML = `
    <article class="card kpi-card">
      <p>Overall Activity</p>
      <h2>${overallActivity}</h2>
    </article>
    <article class="card kpi-card">
      <p>Workshop Calling Activity</p>
      <h2>${preActivity}</h2>
    </article>
    <article class="card kpi-card">
      <p>Admission Calling Activity</p>
      <h2>${postActivity}</h2>
    </article>
  `;
}

function renderAll() {
  const timelineLeads = applyTimelineFilter(getAllLeads());
  const allLeads = getScopedLeads(timelineLeads);
  const preLeads = getPreLeads(allLeads);
  const postLeads = getPostLeads(allLeads);
  const counselors = getCounselorBuckets(allLeads);

  renderKpis(allLeads, preLeads, postLeads);

  const preRows = buildRows(counselors, preLeads, "preActivityUpdates", "wsStatus");
  renderMonitoringTable(preMonitoringTable, preRows);

  const postRows = buildRows(counselors, postLeads, "postActivityUpdates", "courseStatus");
  renderMonitoringTable(postMonitoringTable, postRows);

  if (exportMonitoringBtn) {
    exportMonitoringBtn.onclick = () => {
      exportMonitoringExcel();
    };
  }
}

bindTimelineControls();
renderAll();
const stopStatePolling = startStatePolling(() => {
  renderAll();
});
registerPageCleanup(stopStatePolling);
