import { syncStateFromLocal } from "./state-sync.js";

const TASKS_KEY = "dvWorkshopTasks";
export const TASK_CATEGORY = {
  workshop: "workshop",
  admission: "admission"
};

const CATEGORY_LABELS = {
  [TASK_CATEGORY.workshop]: "Workshop Calling",
  [TASK_CATEGORY.admission]: "Admission Calling"
};

function safeParseArray(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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
  const raw = localStorage.getItem(TASKS_KEY);
  const tasks = safeParseArray(raw);
  return tasks.map((task) => normalizeTask(task));
}

export function getTasksByCategory(category) {
  return getTasks().filter((task) => task.category === category);
}

export function getTaskCategoryLabel(category) {
  return CATEGORY_LABELS[category] || "Task";
}

export async function saveTasks(tasks) {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks.map((task) => normalizeTask(task))));
  return syncStateFromLocal();
}

export async function createTask(taskInput) {
  const tasks = getTasks();
  const nextTask = normalizeTask(taskInput);
  tasks.unshift(nextTask);
  await saveTasks(tasks);
  return nextTask;
}

export async function updateTask(taskId, updates) {
  const tasks = getTasks();
  const index = tasks.findIndex((task) => String(task.id) === String(taskId));
  if (index === -1) {
    return null;
  }

  const updatedTask = normalizeTask({
    ...tasks[index],
    ...updates,
    updatedAt: new Date().toISOString()
  });

  tasks[index] = updatedTask;
  await saveTasks(tasks);
  return updatedTask;
}

export async function deleteTask(taskId) {
  const tasks = getTasks();
  const nextTasks = tasks.filter((task) => String(task.id) !== String(taskId));
  if (nextTasks.length === tasks.length) {
    return false;
  }

  await saveTasks(nextTasks);
  return true;
}
