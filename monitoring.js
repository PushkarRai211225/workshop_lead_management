import { bootstrapLocalState } from "./state-sync.js";

const LEADS_KEY = "dvWorkshopLeads";
const SESSION_KEY = "dvWorkshopSession";

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

const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");

let timelineFilter = {
  type: "week",
  startDate: "",
  endDate: ""
};

function isCounselorSession() {
  return session?.role === "counselor";
}

function getScopedLeads(allLeads) {
  if (!isCounselorSession()) {
    return allLeads;
  }

  const counselorName = String(session?.name || "").trim().toLowerCase();
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
    lead.wsStatus = lead.wsStatus || "Not Interested";
    lead.whatsappInvite = lead.whatsappInvite || "No";
    lead.counselor = lead.counselor || "Unassigned";

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

function applyTimelineFilter(leads) {
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
    monitoringStartDateWrap.classList.toggle("hidden", timelineFilter.type !== "custom");
    monitoringEndDateWrap.classList.toggle("hidden", timelineFilter.type !== "custom");
  };

  monitoringStartDate.onchange = (event) => {
    timelineFilter.startDate = event.target.value;
  };

  monitoringEndDate.onchange = (event) => {
    timelineFilter.endDate = event.target.value;
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
    bindTimelineControls();
    renderAll();
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

function getPreLeads(allLeads) {
  return allLeads.filter((lead) => !isPostWorkshopLead(lead));
}

function getPostLeads(allLeads) {
  return allLeads.filter((lead) => isPostWorkshopLead(lead));
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
    const activities = leads.reduce((sum, lead) => sum + (Number(lead[activityKey]) || 0), 0);
    const interested = leads.filter((lead) => lead[statusKey] === "Interested").length;
    const notInterested = leads.filter((lead) => lead[statusKey] === "Not Interested").length;
    const enrolled = leads.filter((lead) => lead.admissionStatus === "Enrolled").length;
    const won = leads.filter((lead) => lead.admissionStatus === "Won").length;

    return {
      counselor,
      activities,
      workshops: formatBreakdown(leads, "workshop"),
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
      <p>Pre-Workshop Activity</p>
      <h2>${preActivity}</h2>
    </article>
    <article class="card kpi-card">
      <p>Post-Workshop Activity</p>
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
}

bindTimelineControls();
renderAll();
