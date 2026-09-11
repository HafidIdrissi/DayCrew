import type {
  AutonomyLevel,
  PermissionPolicy,
  RiskLevel,
  RiskyAction,
} from "@daycrew/shared";

const hardBoundaries = new Set<RiskyAction>([
  "shell.destructive",
  "filesystem.delete",
  "external.publish",
  "money.spend",
  "git.destructive",
  "credential.access",
]);

export const permissionPolicyFor = (autonomy: AutonomyLevel): PermissionPolicy => ({
  mode:
    autonomy === "assist"
      ? "confirm-all"
      : autonomy === "work-with-approval"
        ? "ask-risky"
        : "bounded-auto",
  hardBoundariesRequireApproval: true,
});

export const requiresHumanApproval = (
  autonomy: AutonomyLevel,
  action: RiskyAction,
  risk: RiskLevel,
): boolean => {
  if (hardBoundaries.has(action) || risk === "critical") return true;
  if (autonomy === "assist") return true;
  if (autonomy === "work-with-approval") return risk === "medium" || risk === "high";
  return false;
};
