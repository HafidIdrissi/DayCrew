import { useEffect, useRef, useState, type FormEvent } from "react";
import { listEngineModels } from "./api";
import { Icon } from "./components";
import { PixelAvatar } from "./avatar";
import { Button } from "./ui";
import type { Engine, EngineDetection, EngineModel, TeamMember } from "./types";

const specialties = [
  { role: "Developer", symbol: "</>", description: "Build features", mission: "Implement focused, maintainable changes. Follow the project's conventions, test the affected behavior, and explain the result and any remaining limitations." },
  { role: "Researcher", symbol: "◎", description: "Find answers", mission: "Investigate the question using primary sources. Compare the options, cite evidence, distinguish facts from assumptions, and recommend a clear next step." },
  { role: "QA", symbol: "✓", description: "Catch problems", mission: "Review the work against the goal. Reproduce issues, test important user journeys and edge cases, and report actionable findings with clear steps to reproduce." },
];

type AgentValues = Pick<TeamMember, "name" | "role" | "instructions" | "engine">;
type CatalogState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; models: EngineModel[]; source: "live" | "catalog"; allowsCustomModelId: boolean; warning?: string }
  | { status: "failed"; message: string };

const CUSTOM = "__custom__";

/** Shown when an engine is selected but its catalogue cannot be read. */
const catalogNotice = (catalog: CatalogState): string | undefined => {
  if (catalog.status === "loading") return "Loading models...";
  if (catalog.status === "failed") return catalog.message;
  if (catalog.status === "ready" && catalog.warning) return catalog.warning;
  if (catalog.status === "ready" && catalog.models.length === 0) return "This engine published no models. Enter a model identifier or use the engine default.";
  return undefined;
};

export const AgentForm = ({ member, engines = [], detections = [], selectionId, onSave, onCancel }: {
  member?: TeamMember;
  engines?: Engine[];
  detections?: EngineDetection[];
  selectionId?: string;
  onSave: (value: AgentValues) => Promise<void>;
  onCancel: () => void;
}) => {
  const [name, setName] = useState(member?.name ?? "");
  const [role, setRole] = useState(member?.role ?? "");
  const [instructions, setInstructions] = useState(member?.instructions ?? "");
  const [provider, setProvider] = useState(member?.engine.mode === "manual" ? member.engine.provider ?? "claude-code" : "auto");
  // "" means "let the engine choose". An existing agent keeps the model it was saved with.
  const [model, setModel] = useState(member?.engine.mode === "manual" ? member.engine.model ?? "" : "");
  const [customModel, setCustomModel] = useState(false);
  const [catalog, setCatalog] = useState<CatalogState>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const nameField = useRef<HTMLInputElement>(null);
  const roleField = useRef<HTMLInputElement>(null);
  const missionField = useRef<HTMLTextAreaElement>(null);
  const template = specialties.find((item) => item.role === role);
  // Auto is defined by the registry, not by this screen, so the label stays honest.
  const autoEngine = engines.find((item) => item.autoEligible);
  const effectiveProvider = provider === "auto" ? autoEngine?.id ?? "claude-code" : provider;
  const detection = detections.find((item) => item.id === effectiveProvider);
  const engine = engines.find((item) => item.id === effectiveProvider);
  const manual = provider !== "auto";
  const supportsModels = manual && engine !== undefined && engine.modelDiscovery !== "unsupported";
  // Drop a saved model only when the registry positively says the engine takes none,
  // so a failed registry load cannot silently reset an agent on save.
  const keepsModel = manual && (supportsModels || engine === undefined);

  useEffect(() => {
    if (!supportsModels || !selectionId) { setCatalog({ status: "idle" }); return; }
    let active = true;
    setCatalog({ status: "loading" });
    void listEngineModels(effectiveProvider, selectionId)
      .then((next) => {
        if (!active) return;
        setCatalog({
          status: "ready", models: next.models, source: next.source, allowsCustomModelId: next.allowsCustomModelId,
          ...(next.warning ? { warning: next.warning } : {}),
        });
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setCatalog({ status: "failed", message: caught instanceof Error ? caught.message : "DayCrew could not load this engine's models." });
      });
    return () => { active = false; };
  }, [effectiveProvider, supportsModels, selectionId]);

  const chooseProvider = (next: string) => {
    setProvider(next);
    setCustomModel(false);
    // A model belongs to one engine, so switching engines returns to its default.
    const original = member?.engine.mode === "manual" ? member.engine : undefined;
    setModel(next !== "auto" && original?.provider === next ? original.model ?? "" : "");
  };
  const chooseModel = (value: string) => {
    if (value === CUSTOM) { setCustomModel(true); setModel(""); return; }
    setCustomModel(false);
    setModel(value);
  };
  const chooseRole = (next: typeof specialties[number]) => {
    setRole(next.role);
    // Preserve the user's brief; only replace untouched starter text.
    if (!instructions.trim() || specialties.some((item) => item.mission === instructions)) setInstructions(next.mission);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current) return;
    const missing = !name.trim() ? nameField : !role.trim() ? roleField : !instructions.trim() ? missionField : undefined;
    if (missing) { setError("Add a name, a role and instructions before saving."); missing.current?.focus(); return; }
    pending.current = true;
    setBusy(true); setError(undefined);
    try {
      await onSave({
        name: name.trim(), role: role.trim(), instructions: instructions.trim(),
        engine: manual
          ? { mode: "manual", provider, ...(keepsModel && model.trim() ? { model: model.trim() } : {}) }
          : { mode: "auto" },
      });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save this agent. Your changes are still here."); }
    finally { pending.current = false; setBusy(false); }
  };
  const models = catalog.status === "ready" ? catalog.models : [];
  const allowsCustom = catalog.status === "ready" ? catalog.allowsCustomModelId : engine?.allowsCustomModelId ?? false;
  // A saved model that is no longer listed must stay visible instead of silently resetting.
  const unlisted = model !== "" && !customModel && !models.some((item) => item.id === model);
  const notice = catalogNotice(catalog);
  return <section className="agent-editor" aria-label={member ? "Edit agent" : "Create agent"}>
    <header className="agent-editor-heading"><div><span className="agent-eyebrow">BUILD YOUR CREW</span><h1>{member ? "Edit your agent" : "A new teammate, ready to help."}</h1><p>Choose a specialty, describe the job, and make it yours.</p></div><button type="button" className="icon-button" onClick={onCancel} disabled={busy} aria-label="Close agent editor"><Icon name="close" size={20} /></button></header>
    <div className="agent-editor-layout">
      <aside className="agent-preview-column" aria-label="Agent preview">
        <div className="agent-id-card">
          <div className="agent-portrait-stage"><span className="agent-card-stamp">DAYCREW / TEAM MEMBER</span><PixelAvatar member={{ id: member?.id ?? "daycrew-new-colleague", name: name.trim() || "Your next teammate", role, isManager: member?.isManager ?? false }} variant="full" size="lg" /><span className="agent-portrait-platform" /></div>
          <div className="agent-id-caption"><strong>{name.trim() || "Your next teammate"}</strong><span>{role.trim() || "Choose their specialty"}</span><small>{member ? "One of your crew" : "Illustrative avatar · Assigned when saved"}</small></div>
        </div>
        <div className="agent-guide"><Icon name="sparkle" size={20} /><h2>A good brief goes a long way.</h2><p>Tell your agent what to own, how to work and what a good result looks like.</p><p>You can edit these details at any time. Creating an agent does not start a task.</p></div>
      </aside>
      <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
        <section className="agent-form-section" aria-labelledby="agent-identity-title">
          <div className="agent-section-heading"><span>01</span><h2 id="agent-identity-title">Who is joining?</h2></div>
          <label>Name<input ref={nameField} name="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Alex" required maxLength={80} disabled={busy} autoFocus autoComplete="off" /></label>
          <div className="agent-role-options" role="group" aria-label="Role suggestions">{specialties.map((option) => <button type="button" key={option.role} aria-pressed={role === option.role} disabled={busy} onClick={() => chooseRole(option)}><span aria-hidden="true">{option.symbol}</span><strong>{option.role}</strong><small>{option.description}</small></button>)}</div>
          <label>Role<input ref={roleField} name="role" value={role} onChange={(event) => setRole(event.target.value)} placeholder="Choose above or enter a custom role" required maxLength={120} disabled={busy} /></label>
        </section>
        <section className="agent-form-section" aria-labelledby="agent-mission-title">
          <div className="agent-section-heading"><span>02</span><h2 id="agent-mission-title">What should they do?</h2></div>
          <label>Instructions<textarea ref={missionField} name="instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Describe their responsibilities, your project conventions and the result you expect." required maxLength={20_000} disabled={busy} rows={5} /></label>
          <div className="agent-field-footer"><span>Role suggestions include an editable starting brief.</span>{template && !instructions.trim() && <button type="button" className="text-button" disabled={busy} onClick={() => setInstructions(template.mission)}>Use starting brief</button>}</div>
        </section>
        <section className="agent-form-section" aria-labelledby="agent-engine-title">
          <div className="agent-section-heading"><span>03</span><h2 id="agent-engine-title">Choose an AI Engine</h2></div>
          <label>AI Engine<select value={provider} onChange={(event) => chooseProvider(event.target.value)} disabled={busy}>
            <option value="auto">Auto · {autoEngine?.name ?? "Claude Code"} (recommended)</option>
            {engines.map((item) => <option key={item.id} value={item.id}>
              {item.name}
              {item.classification === "read-only-preview" ? " · read-only preview" : ""}
              {item.classification === "restricted-experimental" ? " · experimental" : ""}
              {item.classification === "simulated" ? " · simulated replies" : ""}
            </option>)}
          </select></label>
          <p className="agent-engine-hint">{provider === "auto" ? `Uses ${autoEngine?.name ?? "Claude Code"} when its CLI is installed and signed in on this machine. Auto never selects a preview or experimental engine.` : engine?.binary ? `Runs the ${engine.binary} command on this machine, using the sign-in that tool already has.` : "Uses this engine for the agent's work."}</p>
          {engine?.setup?.signInCommand && <p className="chat-notice" role="status">{engine.name} runs as a local command-line tool. Install it and run <code>{engine.setup.signInCommand}</code>; DayCrew reuses that sign-in and never asks for an API key.</p>}
          {provider !== "demo" && <p className={`agent-readiness ${detection?.ready ? "ready" : ""}`}><Icon name={detection?.ready ? "check" : "settings"} size={16} />{detection ? detection.message : "Readiness has not been checked."}<a href="#settings" target="_blank" rel="noopener" aria-label="Engine settings (opens in a new tab)">Engine settings ↗</a></p>}
          {provider === "demo" && <p className="chat-notice">Demo replies are deterministic simulations, not AI execution.</p>}
          {(provider === "codex" || provider === "gemini" || provider === "cursor" || provider === "grok") && <p className="chat-notice">Restricted preview: runs from a temporary folder. Project files are not copied, but access outside that folder is possible. Explicit consent is required before sending.</p>}
          {supportsModels && <>
            <label>Model<select aria-describedby="agent-model-hint" value={customModel ? CUSTOM : model} disabled={busy || catalog.status === "loading"} onChange={(event) => chooseModel(event.target.value)}>
              <option value="">Default model of the CLI</option>
              {unlisted && <option value={model}>{model} (saved earlier)</option>}
              {models.map((item) => <option key={item.id} value={item.id}>{item.label === item.id ? item.id : `${item.label} · ${item.id}`}</option>)}
              {allowsCustom && <option value={CUSTOM}>Custom model identifier…</option>}
            </select></label>
            {customModel && <label>Model identifier<input name="customModel" value={model} disabled={busy} maxLength={200} placeholder={engine?.models[0]?.id ?? "model-id-accepted-by-this-cli"} onChange={(event) => setModel(event.target.value)} /></label>}
            <p className="agent-engine-hint" id="agent-model-hint">
              {notice ?? (catalog.status === "ready" && catalog.source === "live"
                ? `${models.length} model${models.length === 1 ? "" : "s"} reported by ${engine?.name}.`
                : `Maintained list, checked against the CLI documentation on ${engine?.modelsVerifiedAt ?? "a recent date"}.`)}
              {" "}Leaving this on the CLI default keeps existing agents unchanged.
            </p>
          </>}
          {manual && engine?.modelDiscovery === "unsupported" && <p className="agent-engine-hint">{engine.name} takes no model choice.</p>}
          <details className="advanced-options"><summary>Model details</summary><p>{model.trim() ? `This agent runs ${engine?.binary ?? "the CLI"} with --model ${model.trim()}.` : "Uses whichever model the CLI is configured to use by default."} Earlier messages keep their original attribution.</p></details>
        </section>
        {error && <p role="alert" className="inline-error">{error}</p>}
        <div className="chat-actions agent-save-actions"><Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button><Button disabled={busy}>{busy ? "Saving..." : member ? "Save changes" : "Add to the crew"}<Icon name="arrow" size={16} /></Button></div>
      </form>
    </div>
  </section>;
};
