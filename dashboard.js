import { bootstrapLocalState, loadPersistedValue, savePersistedValue } from "./state-sync.js";

const SESSION_KEY = "dvWorkshopSession";
const LEADS_KEY = "dvWorkshopLeads";

await bootstrapLocalState();

const interestedPanelNote = document.getElementById("interestedPanelNote");
const interestedWorkshopList = document.getElementById("interestedWorkshopList");
const trendRangeText = document.getElementById("trendRangeText");
const pieRangeText = document.getElementById("pieRangeText");

const timelinePreset = document.getElementById("timelinePreset");
const customRangeFields = document.getElementById("customRangeFields");
const startDateInput = document.getElementById("startDate");
const endDateInput = document.getElementById("endDate");
const applyCustomRangeBtn = document.getElementById("applyCustomRange");
const activeRangeLabel = document.getElementById("activeRangeLabel");

const overallLeadsEl = document.getElementById("overallLeads");
const newLeadsEl = document.getElementById("newLeads");
const interestedLeadsEl = document.getElementById("interestedLeads");
const convertedLeadsEl = document.getElementById("convertedLeads");

const session = JSON.parse(localStorage.getItem(SESSION_KEY));
if (!session || !session.role) {
  window.location.href = "index.html";
}

const isAdmin = session.role === "admin";
interestedPanelNote.textContent = isAdmin
  ? "Live view of interested leads by workshop and potential follow-ups."
  : "Read-only insight for counselors to prioritize warm prospects.";

const TIMELINE_STORAGE_KEY = "dvWorkshopDashboardTimeline";
const DEFAULT_TIMELINE_STATE = {
  preset: "weekly",
  startDate: "",
  endDate: ""
};

const persistedTimelineState = {
  ...DEFAULT_TIMELINE_STATE,
  ...loadPersistedValue(TIMELINE_STORAGE_KEY, {})
};

timelinePreset.value = persistedTimelineState.preset || DEFAULT_TIMELINE_STATE.preset;
startDateInput.value = persistedTimelineState.startDate || "";
endDateInput.value = persistedTimelineState.endDate || "";
customRangeFields.classList.toggle("hidden", timelinePreset.value !== "custom");

function persistTimelineState() {
  savePersistedValue(TIMELINE_STORAGE_KEY, {
    preset: timelinePreset.value,
    startDate: startDateInput.value,
    endDate: endDateInput.value
  });
}

function getLeads() {
  const existing = localStorage.getItem(LEADS_KEY);
  if (!existing) {
    return [];
  }

  try {
    const parsed = JSON.parse(existing);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildKpis(leads) {
  const totals = leads.reduce(
    (accumulator, lead) => {
      accumulator.total += 1;
      const status = getLeadStatus(lead);
      if (status === "New") accumulator.newLeads += 1;
      if (status === "Interested") accumulator.interested += 1;
      if (status === "Converted") accumulator.converted += 1;
      return accumulator;
    },
    { total: 0, newLeads: 0, interested: 0, converted: 0 }
  );

  overallLeadsEl.textContent = totals.total;
  newLeadsEl.textContent = totals.newLeads;
  interestedLeadsEl.textContent = totals.interested;
  convertedLeadsEl.textContent = totals.converted;
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getLeadStatus(lead) {
  const status = String(lead?.status || "").trim();
  if (!status || status.toLowerCase() === "select") {
    return "New";
  }

  return status;
}

function parseDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatReadableDate(date) {
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function getLatestLeadDate(leads) {
  if (!leads.length) {
    return new Date();
  }

  return leads
    .map((lead) => parseDateKey(lead.createdAt))
    .sort((a, b) => a - b)
    .at(-1);
}

function getDateSequence(startDate, endDate) {
  const dates = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    dates.push(toDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function getQuarterBounds(referenceDate) {
  const quarterStartMonth = Math.floor(referenceDate.getMonth() / 3) * 3;
  const start = new Date(referenceDate.getFullYear(), quarterStartMonth, 1);
  const end = new Date(referenceDate.getFullYear(), quarterStartMonth + 3, 0);
  return { start, end };
}

function getTimelineRange(leads) {
  const preset = timelinePreset.value;
  const referenceDate = getLatestLeadDate(leads);
  const start = new Date(referenceDate);
  const end = new Date(referenceDate);

  if (preset === "overall") {
    if (!leads.length) {
      return {
        start,
        end,
        label: "Overall: All available lead data"
      };
    }

    const dates = leads.map((lead) => parseDateKey(lead.createdAt)).sort((a, b) => a - b);
    return {
      start: dates[0],
      end: dates[dates.length - 1],
      label: "Overall: All available lead data"
    };
  }

  if (preset === "daily") {
    return {
      start,
      end,
      label: `Daily: ${formatReadableDate(start)}`
    };
  }

  if (preset === "weekly") {
    start.setDate(end.getDate() - 6);
    return {
      start,
      end,
      label: `Weekly: ${formatReadableDate(start)} - ${formatReadableDate(end)}`
    };
  }

  if (preset === "monthly") {
    const monthStart = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
    const monthEnd = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0);
    return {
      start: monthStart,
      end: monthEnd,
      label: `Monthly: ${monthStart.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}`
    };
  }

  if (preset === "quarterly") {
    const quarter = getQuarterBounds(referenceDate);
    const quarterIndex = Math.floor(referenceDate.getMonth() / 3) + 1;
    return {
      start: quarter.start,
      end: quarter.end,
      label: `Quarterly: Q${quarterIndex} ${referenceDate.getFullYear()}`
    };
  }

  const customStart = startDateInput.value ? parseDateKey(startDateInput.value) : null;
  const customEnd = endDateInput.value ? parseDateKey(endDateInput.value) : null;

  if (!customStart || !customEnd || customStart > customEnd) {
    return {
      start: null,
      end: null,
      label: "Custom: Select a valid date range"
    };
  }

  return {
    start: customStart,
    end: customEnd,
    label: `Custom: ${formatReadableDate(customStart)} - ${formatReadableDate(customEnd)}`
  };
}

function filterLeadsByTimeline(leads, range) {
  if (!range.start || !range.end) {
    return [];
  }

  const startTime = range.start.getTime();
  const endTime = range.end.getTime();

  return leads.filter((lead) => {
    const leadTime = parseDateKey(lead.createdAt).getTime();
    return leadTime >= startTime && leadTime <= endTime;
  });
}

let trendChart;
let workshopPieChart;

function renderCharts(leads, range) {
  const trendCanvas = document.getElementById("newLeadsTrendChart");
  const pieCanvas = document.getElementById("workshopBreakdownChart");

  const trendDates = range.start && range.end ? getDateSequence(range.start, range.end) : [];
  const trendCountMap = new Map();
  leads.forEach((lead) => {
    if (getLeadStatus(lead) === "New") {
      trendCountMap.set(lead.createdAt, (trendCountMap.get(lead.createdAt) || 0) + 1);
    }
  });

  const trendCounts = trendDates.map((day) => {
    return trendCountMap.get(day) || 0;
  });

  const workshopMap = leads.reduce((acc, lead) => {
    acc[lead.workshop] = (acc[lead.workshop] || 0) + 1;
    return acc;
  }, {});

  if (trendChart) {
    trendChart.destroy();
  }
  if (workshopPieChart) {
    workshopPieChart.destroy();
  }

  trendChart = new Chart(trendCanvas, {
    type: "line",
    data: {
      labels: trendDates.map((d) => d.slice(5)),
      datasets: [
        {
          label: "New Leads",
          data: trendCounts,
          borderColor: "#1e3a8a",
          backgroundColor: "rgba(30, 58, 138, 0.12)",
          tension: 0.35,
          pointRadius: 4,
          pointHoverRadius: 5,
          fill: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        }
      },
      scales: {
        y: {
          ticks: { precision: 0 },
          beginAtZero: true,
          grid: {
            color: "rgba(16,24,40,0.08)"
          }
        },
        x: {
          grid: {
            display: false
          }
        }
      }
    }
  });

  workshopPieChart = new Chart(pieCanvas, {
    type: "pie",
    data: {
      labels: Object.keys(workshopMap),
      datasets: [
        {
          data: Object.values(workshopMap),
          backgroundColor: ["#1e3a8a", "#3b82f6", "#0f766e", "#94a3b8", "#ea580c"],
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.85)"
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom"
        }
      }
    }
  });

  trendRangeText.textContent = range.label;
  pieRangeText.textContent = `${range.label} breakdown`;
}

function renderInterestedPanel(leads) {
  const interestedLeads = leads.filter((lead) => getLeadStatus(lead) === "Interested");

  if (!interestedLeads.length) {
    interestedWorkshopList.innerHTML = `
      <article class="interested-item empty-state">
        <h4>No interested leads yet</h4>
        <p>Once leads move to Interested status, workshop-wise insights will appear here.</p>
      </article>
    `;
    return;
  }

  const groupedByWorkshop = interestedLeads.reduce((acc, lead) => {
    if (!acc[lead.workshop]) {
      acc[lead.workshop] = [];
    }
    acc[lead.workshop].push(lead);
    return acc;
  }, {});

  const maxCount = Math.max(...Object.values(groupedByWorkshop).map((items) => items.length), 1);

  interestedWorkshopList.innerHTML = Object.entries(groupedByWorkshop)
    .sort(([, a], [, b]) => b.length - a.length)
    .map(([workshop, workshopLeads]) => {
      const ratio = Math.round((workshopLeads.length / maxCount) * 100);
      const names = workshopLeads.map((lead) => lead.name).join(", ");

      return `
      <article class="interested-item">
        <div class="interested-row">
          <h4>${workshop}</h4>
          <span class="interested-count">${workshopLeads.length} Interested</span>
        </div>
        <div class="interested-meter">
          <span style="width: ${ratio}%"></span>
        </div>
        <p title="${names}">${names}</p>
      </article>
      `;
    })
    .join("");
}

function hydrate(leads) {
  const range = getTimelineRange(leads);
  const filteredLeads = filterLeadsByTimeline(leads, range);

  activeRangeLabel.textContent = `${range.label} | Leads in range: ${filteredLeads.length}`;
  buildKpis(filteredLeads);
  renderCharts(filteredLeads, range);
  renderInterestedPanel(filteredLeads);
}

const leads = getLeads();
hydrate(leads);

timelinePreset.addEventListener("change", () => {
  const showCustom = timelinePreset.value === "custom";
  customRangeFields.classList.toggle("hidden", !showCustom);
  persistTimelineState();
  hydrate(getLeads());
});

startDateInput.addEventListener("change", () => {
  persistTimelineState();
});

endDateInput.addEventListener("change", () => {
  persistTimelineState();
});

applyCustomRangeBtn.addEventListener("click", () => {
  persistTimelineState();
  hydrate(getLeads());
});
