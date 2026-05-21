import { bootstrapLocalState, syncStateFromLocal } from "./state-sync.js";

const COUNSELORS_KEY = "dvCounselors";
const LEADS_KEY = "dvWorkshopLeads";
const ALLOCATION_KEY = "dvCounselorAllocation";

await bootstrapLocalState();

const DEFAULT_PERMISSIONS = {
  dashboard: false,
  preWorkshop: true,
  postWorkshop: true,
  lostLeads: true,
  monitoring: true
};

const counselorForm = document.getElementById("counselorForm");
const counselorFormMessage = document.getElementById("counselorFormMessage");
const counselorList = document.getElementById("counselorList");

function setMessage(text, isError = true) {
  counselorFormMessage.textContent = text;
  counselorFormMessage.style.color = isError ? "#b42318" : "#0f766e";
}

function getCounselors() {
  const raw = localStorage.getItem(COUNSELORS_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid counselors");
    }

    return parsed.map((item) => ({
      ...item,
      email: String(item.email || "").toLowerCase(),
      permissions: {
        ...DEFAULT_PERMISSIONS,
        ...(item.permissions || {})
      }
    }));
  } catch {
    return [];
  }
}

function saveCounselors(counselors) {
  localStorage.setItem(COUNSELORS_KEY, JSON.stringify(counselors));
  return syncStateFromLocal();
}

function getLeads() {
  const raw = localStorage.getItem(LEADS_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLeads(leads) {
  localStorage.setItem(LEADS_KEY, JSON.stringify(leads));
  return syncStateFromLocal();
}

function getAllocation() {
  const raw = localStorage.getItem(ALLOCATION_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAllocation(allocation) {
  localStorage.setItem(ALLOCATION_KEY, JSON.stringify(allocation));
  return syncStateFromLocal();
}

async function syncAllocationWithCounselors(counselors) {
  const counselorNames = [...new Set(
    counselors
      .map((item) => String(item.name || "").trim())
      .filter(Boolean)
  )];

  const existing = getAllocation();
  const byName = new Map(
    existing.map((item) => [String(item.name || "").trim().toLowerCase(), Number(item.percentage || 0)])
  );

  const next = counselorNames.map((name) => ({
    name,
    percentage: byName.get(name.toLowerCase()) || 0
  }));

  await saveAllocation(next);
}

function rebalanceAllocation(items) {
  if (!items.length) {
    return [];
  }

  const total = items.reduce((sum, item) => sum + Number(item.percentage || 0), 0);
  if (total <= 0) {
    const even = 100 / items.length;
    return items.map((item) => ({
      name: item.name,
      percentage: Number(even.toFixed(2))
    }));
  }

  let normalized = items.map((item) => ({
    name: item.name,
    percentage: Number((((Number(item.percentage || 0) / total) * 100).toFixed(2)))
  }));

  const roundedTotal = normalized.reduce((sum, item) => sum + item.percentage, 0);
  const delta = Number((100 - roundedTotal).toFixed(2));
  if (normalized.length && delta !== 0) {
    normalized[normalized.length - 1].percentage = Number(
      (normalized[normalized.length - 1].percentage + delta).toFixed(2)
    );
  }

  return normalized;
}

async function removeCounselor(counselorId) {
  const counselors = getCounselors();
  const target = counselors.find((item) => item.id === counselorId);
  if (!target) {
    setMessage("Counselor not found.", true);
    return;
  }

  const confirmed = window.confirm(`Remove counselor ${target.name}?`);
  if (!confirmed) {
    return;
  }

  const nextCounselors = counselors.filter((item) => item.id !== counselorId);
  await saveCounselors(nextCounselors);
  await syncAllocationWithCounselors(nextCounselors);

  const leads = getLeads();
  let changed = false;
  const updatedLeads = leads.map((lead) => {
    if (String(lead.counselor || "").toLowerCase() === target.name.toLowerCase()) {
      changed = true;
      return {
        ...lead,
        counselor: "Unassigned"
      };
    }
    return lead;
  });
  if (changed) {
    await saveLeads(updatedLeads);
  }

  const allocation = getAllocation();
  const filteredAllocation = allocation.filter(
    (item) => String(item.name || "").toLowerCase() !== target.name.toLowerCase()
  );
  if (filteredAllocation.length !== allocation.length) {
    await saveAllocation(rebalanceAllocation(filteredAllocation));
  }

  setMessage(`Counselor ${target.name} removed successfully.`, false);
  renderCounselorList();
}

function permissionText(permissions) {
  const names = [];
  if (permissions.preWorkshop) names.push("Pre-Workshop");
  if (permissions.postWorkshop) names.push("Post-Workshop");
  if (permissions.lostLeads) names.push("Lost Leads");
  if (permissions.monitoring) names.push("Monitoring");
  return names.length ? names.join(", ") : "No access";
}

function renderCounselorList() {
  const counselors = getCounselors();

  counselorList.innerHTML = `
    <div class="table-scroll">
      <table class="compact-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Phone</th>
            <th>Permissions</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${counselors
            .map(
              (counselor) => `
                <tr>
                  <td>${counselor.name}</td>
                  <td>${counselor.email}</td>
                  <td>${counselor.phone || "-"}</td>
                  <td>${permissionText(counselor.permissions || DEFAULT_PERMISSIONS)}</td>
                  <td>
                    <button
                      type="button"
                      class="btn-ghost remove-counselor-btn"
                      data-counselor-id="${counselor.id}"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;

  document.querySelectorAll(".remove-counselor-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const counselorId = button.getAttribute("data-counselor-id");
      if (!counselorId) {
        return;
      }
      void removeCounselor(counselorId);
    });
  });
}

function getSelectedPermissions() {
  const checked = Array.from(
    document.querySelectorAll("input[name='permission']:checked")
  ).map((item) => item.value);

  return {
    dashboard: false,
    preWorkshop: checked.includes("preWorkshop"),
    postWorkshop: checked.includes("postWorkshop"),
    lostLeads: checked.includes("lostLeads"),
    monitoring: checked.includes("monitoring")
  };
}

counselorForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = document.getElementById("counselorName").value.trim();
  const email = document.getElementById("counselorEmail").value.trim().toLowerCase();
  const phone = document.getElementById("counselorPhone").value.trim();
  const password = document.getElementById("counselorPassword").value.trim();
  const permissions = getSelectedPermissions();

  if (!name || !email || !phone || !password) {
    setMessage("All counselor fields are required.", true);
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setMessage("Enter a valid counselor email address.", true);
    return;
  }

  if (!Object.values(permissions).some(Boolean)) {
    setMessage("Select at least one access permission.", true);
    return;
  }

  const counselors = getCounselors();
  if (counselors.some((item) => item.email === email)) {
    setMessage("A counselor with this email already exists.", true);
    return;
  }

  counselors.push({
    id: `c-${Date.now()}`,
    name,
    email,
    phone,
    password,
    permissions
  });

  await saveCounselors(counselors);
  await syncAllocationWithCounselors(counselors);
  counselorForm.reset();

  // restore default checked state for convenience
  document.querySelectorAll("input[name='permission']").forEach((item) => {
    item.checked = true;
  });

  setMessage("Counselor created successfully.", false);
  renderCounselorList();
});

renderCounselorList();
