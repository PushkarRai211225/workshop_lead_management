import { getTasks as getStoredTasks, saveTasks as saveStoredTasks } from "./state-sync.js";

export const TASK_CATEGORY = {
  workshop: "workshop",
  admission: "admission"
};

const CATEGORY_LABELS = {
  [TASK_CATEGORY.workshop]: "Workshop Calling",
  [TASK_CATEGORY.admission]: "Admission Calling"
};

function createTaskId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `task-${crypto.randomUUID()}`;
  }

  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeTask(task = {}) {
  const category = task.category === TASK_CATEGORY.admission ? TASK_CATEGORY.admission : TASK_CATEGORY.workshop;
  const createdAt = task.createdAt || new Date().toISOString();

  return {
    id: String(task.id || createTaskId()),
    leadId: String(task.leadId || ""),
    leadName: String(task.leadName || "").trim(),
    leadPhone: String(task.leadPhone || "").trim(),
    leadCounselor: String(task.leadCounselor || "").trim(),
    counselor: String(task.counselor || "").trim(),
    category,
    title: String(task.title || "Follow up").trim(),
    notes: String(task.notes || "").trim(),
    dueDate: String(task.dueDate || "").trim(),
    createdAt,
    updatedAt: task.updatedAt || createdAt
  };
}

export function getTasks() {
  const tasks = getStoredTasks();
  return tasks.map((task) => normalizeTask(task));
}

export function getTasksByCategory(category) {
  return getTasks().filter((task) => task.category === category);
}

export function getTaskCategoryLabel(category) {
  return CATEGORY_LABELS[category] || "Task";
}

export async function saveTasks(tasks) {
  return saveStoredTasks(tasks.map((task) => normalizeTask(task)));
}

export async function createTask(taskInput) {
  const tasks = getTasks();
  const nextTask = normalizeTask(taskInput);
  tasks.unshift(nextTask);
  const result = await saveTasks(tasks);
  if (!result || result.ok === false) {
    return { ok: false, message: result?.message || "Failed to save task." };
  }
  return { ok: true, task: nextTask };
}

export async function updateTask(taskId, updates) {
  const tasks = getTasks();
  const index = tasks.findIndex((task) => String(task.id) === String(taskId));
  if (index === -1) {
    return { ok: false, message: "Task not found." };
  }

  const updatedTask = normalizeTask({
    ...tasks[index],
    ...updates,
    updatedAt: new Date().toISOString()
  });

  tasks[index] = updatedTask;
  const result = await saveTasks(tasks);
  if (!result || result.ok === false) {
    return { ok: false, message: result?.message || "Failed to update task." };
  }
  return { ok: true, task: updatedTask };
}

export async function deleteTask(taskId) {
  const tasks = getTasks();
  const nextTasks = tasks.filter((task) => String(task.id) !== String(taskId));
  if (nextTasks.length === tasks.length) {
    return { ok: false, message: "Task not found." };
  }

  const result = await saveTasks(nextTasks);
  if (!result || result.ok === false) {
    return { ok: false, message: result?.message || "Failed to delete task." };
  }
  return { ok: true };
}
