// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PixelAvatar, characterRects, characterTraits, statusMeta } from "./avatar";
import type { MemberStatus } from "./types";

afterEach(cleanup);

const member = (id: string, role = "Implementation", isManager = false) => ({ id, name: `Agent ${id}`, role, isManager });

describe("crew characters", () => {
  it("gives the same agent the same appearance every time it is drawn", () => {
    const first = characterTraits(member("developer"));
    const second = characterTraits(member("developer"));
    expect(second).toEqual(first);
    // Identity drives appearance, so a renamed role must not repaint the character.
    expect(characterTraits(member("developer", "Staff Engineer"))).toMatchObject({
      skin: first.skin, hair: first.hair, hairStyle: first.hairStyle, shirt: first.shirt, accessory: first.accessory,
    });
  });

  it("spreads appearances across a team instead of repeating one look", () => {
    const ids = ["manager", "architect", "developer", "qa-engineer", "researcher", "writer", "analyst", "designer"];
    const looks = new Set(ids.map((id) => {
      const traits = characterTraits(member(id));
      return `${traits.skin}|${traits.hair}|${traits.hairStyle}|${traits.shirt}|${traits.accessory}`;
    }));
    expect(looks.size).toBeGreaterThanOrEqual(7);
  });

  it("marks Managers on the character itself, not only with colour", () => {
    const lead = characterTraits(member("manager", "Manager", true));
    const crew = characterTraits(member("manager-lookalike", "Implementation"));
    expect(lead.isManager).toBe(true);
    expect(crew.isManager).toBe(false);
    // The badge adds shapes to the silhouette, so the lead is readable in greyscale.
    expect(characterRects(lead, false).length).toBeGreaterThan(characterRects({ ...lead, isManager: false }, false).length);
  });

  it("keeps appearance independent of runtime state", () => {
    const traits = characterTraits(member("developer"));
    const states: MemberStatus[] = ["idle", "working", "blocked-on-approval", "failed"];
    states.forEach((status) => {
      cleanup();
      render(<PixelAvatar member={member("developer")} status={status} showStatus />);
      const drawn = document.querySelectorAll(".pixel-avatar rect");
      expect(drawn.length).toBe(characterRects(traits, false).length);
      expect(screen.getByRole("img").getAttribute("aria-label")).toContain(statusMeta[status].label);
    });
  });

  it("names the agent and its role for hover and assistive technology", () => {
    render(<PixelAvatar member={{ id: "qa", name: "Nadia Quality", role: "QA Engineer", isManager: false }} status="working" />);
    const avatar = screen.getByRole("img");
    expect(avatar.getAttribute("title")).toBe("Nadia Quality · QA Engineer · Working");
    expect(avatar.getAttribute("aria-label")).toBe("Nadia Quality · QA Engineer · Working");
  });

  it("gives every state its own glyph so colour is never the only signal", () => {
    const marks = new Set(Object.values(statusMeta).map((meta) => meta.mark));
    expect(marks.size).toBeGreaterThanOrEqual(5);
  });
});
