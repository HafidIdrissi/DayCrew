// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("Installation command copy", () => {
  it("copies the exact commands without copying the toolbar", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    document.body.innerHTML = "<pre><code>pnpm install\npnpm dev</code></pre>";
    await import("./main");
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("pnpm install\npnpm dev"));
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Copied"));
  });

  it("leaves commands readable and the button available when clipboard access fails", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("Permission denied"); } } });
    document.body.innerHTML = "<pre><code>pnpm dev</code></pre>";
    await import("./main");
    const button = document.querySelector<HTMLButtonElement>("button")!;
    button.click();
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain("Select and copy"));
    expect(document.querySelector("pre code")?.textContent).toBe("pnpm dev");
    expect(button.disabled).toBe(false);
  });
});
