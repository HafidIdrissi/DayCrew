import { describe, expect, it } from "vitest";

import { TeamSchema, TaskStatusSchema } from "./index.js";

const timestamp = "2026-09-09T10:00:00.000Z";

describe("TeamSchema", () => {
  it("requires exactly one Manager", () => {
    const result = TeamSchema.safeParse({
      id: "engineering",
      workspaceId: "daycrew",
      name: "Engineering",
      members: [
        {
          id: "developer",
          name: "Developer",
          role: "Developer",
          instructions: "Build the agreed change.",
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(result.success).toBe(false);
  });

  it("defaults to Work with approval", () => {
    const team = TeamSchema.parse({
      id: "engineering",
      workspaceId: "daycrew",
      name: "Engineering",
      members: [
        {
          id: "manager",
          name: "Engineering Manager",
          role: "Manager",
          instructions: "Coordinate the team.",
          isManager: true,
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(team.autonomy).toBe("work-with-approval");
    expect(team.members[0]?.engine.mode).toBe("auto");
  });
});

describe("TaskStatusSchema", () => {
  it.each(["todo", "in-progress", "review", "done"])(
    "accepts the board state %s",
    (status) => {
      expect(TaskStatusSchema.parse(status)).toBe(status);
    },
  );
});
