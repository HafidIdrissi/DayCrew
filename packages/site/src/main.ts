// Progressive enhancement: installation instructions work without JavaScript.
document.querySelectorAll<HTMLPreElement>("pre").forEach((block) => {
  const code = block.querySelector("code");
  if (!code) return;
  const toolbar = document.createElement("div");
  toolbar.className = "code-toolbar";
  const title = document.createElement("span");
  title.textContent = "TERMINAL";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Copy commands";
  const status = document.createElement("span");
  status.className = "copy-status";
  status.setAttribute("role", "status");
  toolbar.append(title, status, button);
  const panel = document.createElement("div");
  panel.className = "code-panel";
  block.before(panel);
  panel.append(toolbar, block);
  button.addEventListener("click", () => {
    button.disabled = true;
    void Promise.resolve().then(() => navigator.clipboard.writeText(code.textContent ?? "")).then(() => {
      status.textContent = "Copied";
    }).catch(() => {
      status.textContent = "Select and copy the commands below.";
    }).finally(() => { button.disabled = false; });
  });
});

document.querySelectorAll<HTMLAnchorElement>(".mobile-menu a").forEach((link) => {
  link.addEventListener("click", () => link.closest("details")?.removeAttribute("open"));
});
