import type { TaskStatus, TeamMember } from "./types";

export const taskColumns: { status: TaskStatus; label: string }[] = [
  { status: "todo", label: "Todo" },
  { status: "in-progress", label: "In Progress" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

export const taskStatusLabel = (status: TaskStatus): string =>
  taskColumns.find((column) => column.status === status)?.label ?? status;

/** Board and Needs You rows carry only an identity, never a full Member record. */
export const memberShape = (member: { id: string; name: string; role: string }): TeamMember => ({
  ...member,
  instructions: "",
  isManager: false,
  engine: { mode: "auto" },
});
