import type { MemberStatus, TeamMember } from "./types";

/**
 * Crew characters are drawn, never fetched: no avatar service, no bundled
 * portraits, and the same agent id always produces the same person. Appearance
 * comes from identity alone; runtime state is layered on top of it so a Member
 * never changes face when they start working.
 */

const SKIN_TONES = ["#f6d5b8", "#eebd9a", "#e0ab81", "#c88b5f", "#a26a42", "#7a4b2c"];
const SKIN_SHADE = ["#e7bd9a", "#dba57f", "#c9926a", "#ad744b", "#8a5533", "#653c21"];
const HAIR = ["#2b2119", "#4d3117", "#7b4a22", "#b06a2c", "#d8a84a", "#8f95a3", "#5b3fd0", "#c2497f", "#1f6f5c"];
const SHIRT = ["#1769ef", "#0e9f6e", "#7b45f6", "#e8821c", "#dc4257", "#1596ad", "#4a5a80", "#c2317e"];
const SHIRT_DARK = ["#0f4fbb", "#0a7a53", "#5d31c4", "#b96412", "#b02f42", "#0f7286", "#374566", "#98215f"];
const TROUSERS = ["#33405f", "#2a3350", "#4a3466", "#22483a", "#584434", "#3f3f46"];
const ACCENT = ["#ffd166", "#ff8fa3", "#8ecae6", "#b5e48c", "#f4a261", "#cdb4db"];

export type Rect = { x: number; y: number; w: number; h: number; fill: string };

export type CharacterTraits = {
  skin: string;
  skinShade: string;
  hair: string;
  hairStyle: number;
  shirt: string;
  shirtDark: string;
  trousers: string;
  accent: string;
  accessory: number;
  isManager: boolean;
};

/** FNV-1a: small, dependency-free, and stable across reloads and machines. */
const hashOf = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const pick = <T,>(items: readonly T[], seed: number, salt: number): T =>
  items[(Math.imul(seed ^ Math.imul(salt, 0x9e3779b1), 0x85ebca6b) >>> 8) % items.length]!;

export const characterTraits = (member: Pick<TeamMember, "id" | "role" | "isManager">): CharacterTraits => {
  const seed = hashOf(member.id || "daycrew");
  const skinIndex = (Math.imul(seed ^ 0x27d4eb2f, 0x165667b1) >>> 8) % SKIN_TONES.length;
  const shirtIndex = (Math.imul(seed ^ 0x9e3779b1, 0x85ebca6b) >>> 8) % SHIRT.length;
  return {
    skin: SKIN_TONES[skinIndex]!,
    skinShade: SKIN_SHADE[skinIndex]!,
    hair: pick(HAIR, seed, 3),
    hairStyle: (Math.imul(seed ^ 0x5bd1e995, 0xc2b2ae35) >>> 9) % 6,
    shirt: SHIRT[shirtIndex]!,
    shirtDark: SHIRT_DARK[shirtIndex]!,
    trousers: pick(TROUSERS, seed, 11),
    accent: pick(ACCENT, seed, 13),
    accessory: (Math.imul(seed ^ 0x1b873593, 0xcc9e2d51) >>> 11) % 6,
    // Managers read as leads at a glance through a lanyard and badge, never through colour alone.
    isManager: member.isManager || /manager|lead|chief|head of/i.test(member.role ?? ""),
  };
};

const hairShapes = (traits: CharacterTraits): Rect[] => {
  const h = traits.hair;
  const styles: Rect[][] = [
    // 0 short
    [{ x: 4, y: 2, w: 8, h: 2, fill: h }, { x: 3, y: 4, w: 1, h: 2, fill: h }, { x: 12, y: 4, w: 1, h: 2, fill: h }],
    // 1 long
    [{ x: 4, y: 2, w: 8, h: 2, fill: h }, { x: 3, y: 3, w: 1, h: 7, fill: h }, { x: 12, y: 3, w: 1, h: 7, fill: h }],
    // 2 bun
    [{ x: 4, y: 2, w: 8, h: 2, fill: h }, { x: 6, y: 0, w: 4, h: 2, fill: h }, { x: 3, y: 4, w: 1, h: 1, fill: h }, { x: 12, y: 4, w: 1, h: 1, fill: h }],
    // 3 curly
    [{ x: 4, y: 1, w: 8, h: 3, fill: h }, { x: 3, y: 2, w: 1, h: 3, fill: h }, { x: 12, y: 2, w: 1, h: 3, fill: h }, { x: 5, y: 0, w: 6, h: 1, fill: h }],
    // 4 cropped
    [{ x: 4, y: 3, w: 8, h: 1, fill: h }, { x: 4, y: 2, w: 3, h: 1, fill: h }],
    // 5 ponytail
    [{ x: 4, y: 2, w: 8, h: 2, fill: h }, { x: 3, y: 4, w: 1, h: 2, fill: h }, { x: 12, y: 4, w: 2, h: 4, fill: h }],
  ];
  return styles[traits.hairStyle] ?? styles[0]!;
};

const accessoryShapes = (traits: CharacterTraits): Rect[] => {
  const a = traits.accent;
  const styles: Rect[][] = [
    [],
    // glasses
    [{ x: 5, y: 6, w: 3, h: 1, fill: "#2b3147" }, { x: 8, y: 6, w: 3, h: 1, fill: "#2b3147" }],
    // headset
    [{ x: 5, y: 1, w: 6, h: 1, fill: "#2b3147" }, { x: 3, y: 5, w: 1, h: 2, fill: "#2b3147" }, { x: 12, y: 5, w: 1, h: 2, fill: "#2b3147" }],
    // cap
    [{ x: 4, y: 1, w: 8, h: 2, fill: a }, { x: 3, y: 3, w: 10, h: 1, fill: a }],
    // scarf
    [{ x: 5, y: 10, w: 6, h: 1, fill: a }, { x: 5, y: 11, w: 2, h: 2, fill: a }],
    // earring
    [{ x: 3, y: 8, w: 1, h: 1, fill: a }],
  ];
  return styles[traits.accessory] ?? [];
};

/** The body is one shared silhouette so every crew member reads as the same species of drawing. */
export const characterRects = (traits: CharacterTraits, full: boolean): Rect[] => [
  ...(traits.hairStyle === 1 || traits.hairStyle === 5 ? [{ x: 3, y: 3, w: 10, h: 7, fill: traits.hair }] : []),
  { x: 4, y: 3, w: 8, h: 7, fill: traits.skin },
  { x: 3, y: 6, w: 1, h: 2, fill: traits.skin },
  { x: 12, y: 6, w: 1, h: 2, fill: traits.skin },
  ...hairShapes(traits),
  { x: 6, y: 6, w: 1, h: 1, fill: "#2b3147" },
  { x: 9, y: 6, w: 1, h: 1, fill: "#2b3147" },
  { x: 7, y: 8, w: 2, h: 1, fill: traits.skinShade },
  { x: 6, y: 10, w: 4, h: 1, fill: traits.skinShade },
  { x: 4, y: 11, w: 8, h: 5, fill: traits.shirt },
  { x: 6, y: 11, w: 4, h: 1, fill: traits.shirtDark },
  { x: 2, y: 11, w: 2, h: 4, fill: traits.shirtDark },
  { x: 12, y: 11, w: 2, h: 4, fill: traits.shirtDark },
  { x: 2, y: 15, w: 2, h: 1, fill: traits.skin },
  { x: 12, y: 15, w: 2, h: 1, fill: traits.skin },
  ...accessoryShapes(traits),
  ...(traits.isManager ? [
    { x: 7, y: 11, w: 2, h: 2, fill: "#f2f5fb" },
    { x: 6, y: 13, w: 4, h: 2, fill: "#f2f5fb" },
    { x: 7, y: 14, w: 2, h: 1, fill: traits.shirtDark },
  ] : []),
  ...(full ? [
    { x: 5, y: 16, w: 3, h: 3, fill: traits.trousers },
    { x: 8, y: 16, w: 3, h: 3, fill: traits.trousers },
    { x: 5, y: 19, w: 3, h: 1, fill: "#2b3147" },
    { x: 8, y: 19, w: 3, h: 1, fill: "#2b3147" },
  ] : []),
];

export const statusMeta: Record<MemberStatus, { label: string; tone: string; mark: "dot" | "pulse" | "wait" | "alert" | "cross" | "check" }> = {
  idle: { label: "Idle", tone: "muted", mark: "dot" },
  thinking: { label: "Thinking", tone: "violet", mark: "pulse" },
  working: { label: "Working", tone: "green", mark: "pulse" },
  waiting: { label: "Waiting", tone: "amber", mark: "wait" },
  "blocked-on-approval": { label: "Waiting for approval", tone: "red", mark: "alert" },
  paused: { label: "Paused", tone: "amber", mark: "wait" },
  completed: { label: "Completed", tone: "green", mark: "check" },
  failed: { label: "Failed", tone: "red", mark: "cross" },
  stopped: { label: "Stopped", tone: "muted", mark: "cross" },
};

/** Shape as well as colour, so state survives a colour-blind reader and a greyscale print. */
export const StatusMark = ({ status }: { status: MemberStatus }) => {
  const meta = statusMeta[status];
  const glyph = meta.mark === "check" ? "✓" : meta.mark === "cross" ? "✕" : meta.mark === "alert" ? "!" : meta.mark === "wait" ? "…" : "";
  return <span className={`status-mark mark-${meta.mark} status-${meta.tone}`} aria-hidden="true">{glyph}</span>;
};

export type AvatarSize = "xs" | "sm" | "md" | "lg";

export const PixelAvatar = ({ member, size = "md", status, variant = "bust", showStatus = false }: {
  member: Pick<TeamMember, "id" | "name" | "role" | "isManager">;
  size?: AvatarSize;
  status?: MemberStatus;
  variant?: "bust" | "full";
  showStatus?: boolean;
}) => {
  const traits = characterTraits(member);
  const full = variant === "full";
  const rects = characterRects(traits, full);
  const label = `${member.name}${member.role ? ` · ${member.role}` : ""}${status ? ` · ${statusMeta[status].label}` : ""}`;
  return (
    <span
      className={`pixel-avatar avatar-${size} ${full ? "is-full" : "is-bust"} ${traits.isManager ? "is-manager" : ""}`}
      role="img"
      aria-label={label}
      title={label}
      data-status={status ?? "idle"}
    >
      <svg viewBox={full ? "0 0 16 20" : "0 0 16 15"} shapeRendering="crispEdges" aria-hidden="true" focusable="false">
        {rects.map((rect, index) => (
          <rect key={index} x={rect.x} y={rect.y} width={rect.w} height={rect.h} fill={rect.fill} />
        ))}
      </svg>
      {showStatus && status && <StatusMark status={status} />}
    </span>
  );
};
