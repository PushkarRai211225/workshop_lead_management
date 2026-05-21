import { bootstrapLocalState } from "./state-sync.js";
import { deleteTask, getTaskCategoryLabel, getTasksByCategory, TASK_CATEGORY, updateTask } from "./task-service.js";

await bootstrapLocalState();

const workshopTaskSection = document.getElementById("workshopTaskSection");
const admissionTaskSection = document.getElementById("admissionTaskSection");

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function sortTasks(tasks) {
  return [...tasks].sort((left, right) => {
    const leftDate = left.dueDate ? new Date(left.dueDate).getTime() : Number.POSITIVE_INFINITY;
    const rightDate = right.dueDate ? new Date(right.dueDate).getTime() : Number.POSITIVE_INFINITY;
    return leftDate - rightDate || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
}

function renderTaskTable(tasks, emptyMessage) {
  if (!tasks.length) {
    return `<p class="block-help">${emptyMessage}</p>`;
  }

  return `
    <div class="table-scroll">
      <table class="compact-table">
        <thead>
          <tr>
            <th>Lead</th>
            <th>Counselor</th>
            <th>Task</th>
            <th>Notes</th>
            <th>Due Date</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${tasks
            .map(
              (task) => `
                <tr>
                  <td>
                    <strong>${task.leadName || "-"}</strong><br />
                    <span class="muted-text">${task.category === TASK_CATEGORY.workshop ? getTaskCategoryLabel(TASK_CATEGORY.workshop) : getTaskCategoryLabel(TASK_CATEGORY.admission)}</span>
                  </td>
                  <td>${task.leadCounselor || task.counselor || "Unassigned"}</td>
                  <td>${task.title || "Follow up"}</td>
                  <td>${task.notes || "-"}</td>
                  <td>${formatDate(task.dueDate)}</td>
                  <td>
                    <div class="task-actions">
                      <button type="button" class="btn-primary task-complete-btn" data-task-id="${task.id}">Complete</button>
                      <button type="button" class="btn-ghost task-reschedule-btn" data-task-id="${task.id}">Reschedule</button>
                      <button type="button" class="btn-ghost task-remove-btn" data-task-id="${task.id}">Remove</button>
                    </div>
                  </td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

async function completeTask(taskId) {
  await deleteTask(taskId);
  renderAll();
}

async function removeTask(taskId) {
  const confirmed = window.confirm("Remove this task from the tracker?");
  if (!confirmed) {
    return;
  }

  await deleteTask(taskId);
  renderAll();
}

async function rescheduleTask(taskId) {
  const task = [...getTasksByCategory(TASK_CATEGORY.workshop), ...getTasksByCategory(TASK_CATEGORY.admission)]
    .find((item) => String(item.id) === String(taskId));

  if (!task) {
    return;
  }

  const nextDueDate = window.prompt("Enter a new due date (YYYY-MM-DD)", task.dueDate || "");
  if (!nextDueDate) {
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDueDate)) {
    window.alert("Please enter the date in YYYY-MM-DD format.");
    return;
  }

  await updateTask(taskId, { dueDate: nextDueDate });
  renderAll();
}

function bindTaskActions() {
  document.querySelectorAll(".task-complete-btn").forEach((button) => {
    button.onclick = () => {
      const taskId = button.getAttribute("data-task-id");
      if (taskId) {
        void completeTask(taskId);
      }
    };
  });

  document.querySelectorAll(".task-remove-btn").forEach((button) => {
    button.onclick = () => {
      const taskId = button.getAttribute("data-task-id");
      if (taskId) {
        void removeTask(taskId);
      }
    };
  });

  document.querySelectorAll(".task-reschedule-btn").forEach((button) => {
    button.onclick = () => {
      const taskId = button.getAttribute("data-task-id");
      if (taskId) {
        void rescheduleTask(taskId);
      }
    };
  });
}

function renderAll() {
  const workshopTasks = sortTasks(getTasksByCategory(TASK_CATEGORY.workshop));
  const admissionTasks = sortTasks(getTasksByCategory(TASK_CATEGORY.admission));

  workshopTaskSection.innerHTML = renderTaskTable(workshopTasks, "No workshop tasks yet.");
  admissionTaskSection.innerHTML = renderTaskTable(admissionTasks, "No admission tasks yet.");
  bindTaskActions();
}

renderAll();

window.addEventListener("storage", (event) => {
  if (event.key === "dvWorkshopTasks" || event.key === null) {
    renderAll();
  }
});
