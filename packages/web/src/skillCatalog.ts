import type { Task } from "./types";

export const activeTaskFor = (tasks: Task[], memberId: string): Task | undefined =>
  tasks.find((task) => task.ownerId === memberId && task.status !== "done") ??
  tasks.find((task) => task.status !== "done");
