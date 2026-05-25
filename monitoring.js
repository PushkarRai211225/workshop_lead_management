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
const applyMonitoringTimeline = document.getElementById("applyMonitoringTimeline");
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
  monitoringExportMessage.style.color = isError ? "#b42318" : "#0f766e";
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
  });
}

function getAllLeads() {
  const leads = getStoredLeads();
  normalizeLeadFields(leads);
  return leads;
}

function applyTimelineFilter(leads) {
  if (timelineFilter.type === "overall") {
    return leads;
  }

  if (timelineFilter.type === "today") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return leads.filter((lead) => {
      const created = new Date(lead.createdAt);
      created.setHours(0, 0, 0, 0);
      return created.getTime() === today.getTime();
    });
  }

  if (timelineFilter.type === "yesterday") {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    return leads.filter((lead) => {
      const created = new Date(lead.createdAt);
      created.setHours(0, 0, 0, 0);
      return created.getTime() === yesterday.getTime();
    });
  }

  if (timelineFilter.type === "week") {
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

  if (timelineFilter.type === "custom") {
    if (!timelineFilter.startDate || !timelineFilter.endDate) {
      return leads;
    }

    const start = new Date(timelineFilter.startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(timelineFilter.endDate);
    end.setHours(23, 59, 59, 999);

    return leads.filter((lead) => {
      const created = new Date(lead.createdAt);
      return created >= start && created <= end;
    });
  }

  return leads;
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
  };

  monitoringStartDate.onchange = (event) => {
    timelineFilter.startDate = event.target.value;
    persistTimelineFilter();
  };

  monitoringEndDate.onchange = (event) => {
    timelineFilter.endDate = event.target.value;
    persistTimelineFilter();
  };

  applyMonitoringTimeline.onclick = () => {
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

function getCounselors(allLeads) {
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
  const overallActivity = allLeads.reduce(
    (sum, lead) => sum + (Number(lead.preActivityUpdates) || 0) + (Number(lead.postActivityUpdates) || 0),
    0
  );

  const preActivity = preLeads.reduce((sum, lead) => sum + (Number(lead.preActivityUpdates) || 0), 0);
  const postActivity = postLeads.reduce((sum, lead) => sum + (Number(lead.postActivityUpdates) || 0), 0);

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
  const counselors = getCounselors(allLeads);

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
startStatePolling(() => {
  renderAll();
});
