import { useCallback, useEffect, useState } from "react";

import { ApiError, detectEngines, loadSettings, updateDefaultAutonomy } from "./api";
import { AppPage, AppSidebar, Icon } from "./components";
import { readinessState, type Engine, type EngineDetection, type SettingsData, type Team } from "./types";
import { Badge, Button, Card, ErrorState, FormField, LoadingState, Select, Toast } from "./ui";

const classification: Record<Engine["classification"], { label: string; tone: "success" | "info" | "warning" | "neutral" }> = {
  "production-ready": { label: "Production ready", tone: "success" },
  "read-only-preview": { label: "Read-only preview", tone: "info" },
  "restricted-experimental": { label: "Restricted experimental", tone: "warning" },
  simulated: { label: "Simulated", tone: "neutral" },
};

/**
 * "Not checked" and "unknown" are different answers, and neither of them means the
 * CLI is missing: a timeout, a permission error or an unsupported platform all land
 * in "unknown", so the badge never claims more than DayCrew actually established.
 */
const readiness: Record<"ready" | "signed-out" | "not-installed" | "unknown", { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  ready: { label: "Ready to run", tone: "success" },
  "signed-out": { label: "Installed · signed out", tone: "warning" },
  "not-installed": { label: "Not installed", tone: "danger" },
  unknown: { label: "State unknown", tone: "neutral" },
};

/** Install and sign-in guidance. DayCrew prints these commands; it never runs them. */
const EngineSetup = ({ engine, detection }: { engine: Engine; detection?: EngineDetection }) => {
  const setup = engine.setup;
  if (!setup) return null;
  const state = readinessState(detection);
  return <details className="engine-setup" {...(state === "ready" ? {} : { open: true })}>
    <summary>Install and sign in</summary>
    <ol>
      <li>
        <strong>Install {engine.binary ? <code>{engine.binary}</code> : engine.name}</strong>
        {setup.install.map((step) => <span key={step.platform}><em>{step.platform}</em><code>{step.command}</code></span>)}
      </li>
      <li>
        <strong>Sign in</strong>
        {setup.signInCommand
          ? <span><code>{setup.signInCommand}</code></span>
          : <span>Sign in from the engine's own application.</span>}
        <small>{setup.authCheck}</small>
      </li>
    </ol>
    {setup.notes.map((note) => <p key={note}>{note}</p>)}
    <a className="text-button" href={engine.docsUrl} target="_blank" rel="noopener noreferrer">Official documentation ↗</a>
  </details>;
};

export const SettingsPage = ({ selectionId, onSwitchWorkspace, onWorkspaceIssue }: {
  selectionId: string; onSwitchWorkspace: () => void; onWorkspaceIssue: () => void;
}) => {
  const [data, setData] = useState<SettingsData>();
  const [detections, setDetections] = useState<EngineDetection[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const refresh = useCallback(async () => {
    setError(undefined);
    try { setData(await loadSettings(selectionId)); }
    catch (caught) {
      if (caught instanceof ApiError && caught.code?.startsWith("WORKSPACE_")) onWorkspaceIssue();
      else setError(caught instanceof Error ? caught.message : "DayCrew could not load Settings.");
    }
  }, [selectionId, onWorkspaceIssue]);
  useEffect(() => { void refresh(); }, [refresh]);
  const runDetection = async () => {
    setBusy(true); setError(undefined);
    try { setDetections(await detectEngines(selectionId)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "DayCrew could not check AI Engines."); }
    finally { setBusy(false); }
  };
  const saveAutonomy = async (value: Team["autonomy"]) => {
    if (!data) return;
    setBusy(true); setSaved(false);
    try {
      await updateDefaultAutonomy(value, selectionId);
      setData({ ...data, preferences: { defaultAutonomy: value } });
      setSaved(true); window.setTimeout(() => setSaved(false), 2_500);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "DayCrew could not save this preference."); }
    finally { setBusy(false); }
  };
  if (!data && !error) return <div className="app-frame"><AppSidebar needsCount={0} activeView="Settings" /><main className="app-main state-main"><LoadingState label="Loading Settings..." /></main></div>;
  if (!data) return <div className="app-frame"><AppSidebar needsCount={0} activeView="Settings" /><main className="app-main state-main"><ErrorState message={error ?? "Settings are unavailable."} onRetry={() => void refresh()} /></main></div>;
  return <AppPage view="Settings" needsCount={data.needsYouCount} workspace={data.workspace} onSwitchWorkspace={onSwitchWorkspace}>
      <div className="settings-content">
        <header className="page-heading"><p>SETTINGS</p><h1>Make DayCrew work for you.</h1><span>Manage your workspace, check your AI Engines and choose how your teams work.</span></header>
        {error && <p className="inline-error" role="alert"><Icon name="warning" size={15} />{error}</p>}
        {saved && <Toast>Default autonomy saved.</Toast>}

        <Card className="settings-section"><header><div><small>GENERAL</small><h2>Workspace</h2></div></header><dl className="settings-facts"><div><dt>Current Workspace</dt><dd>{data.workspace.name}</dd></div><div><dt>Recent Workspaces</dt><dd>{data.recentWorkspaces.length || "None yet"}</dd></div></dl>{data.recentWorkspaces.length > 0 && <div className="recent-settings-list">{data.recentWorkspaces.map((item) => <button key={item.root} onClick={onSwitchWorkspace}><strong>{item.name}</strong><span>Opened {new Date(item.lastOpenedAt).toLocaleDateString()}</span></button>)}</div>}</Card>

        <Card className="settings-section">
          <header>
            <div>
              <small>AI ENGINES</small><h2>Command-line engines</h2>
              <p>Every engine is a command-line tool you install and sign in to yourself. DayCrew runs it locally and never asks for an API key. Auto only selects Claude Code.</p>
            </div>
            <Button variant="secondary" disabled={busy} onClick={() => void runDetection()}>{busy ? "Checking..." : "Detect AI Engines"}</Button>
          </header>
          <div className="engine-settings-grid">{data.engines.map((engine) => {
            const meta = classification[engine.classification];
            const detected = detections?.find((item) => item.id === engine.id);
            const state = readinessState(detected);
            const badge = readiness[state];
            return <article key={engine.id}>
              <div className="engine-heading">
                <div>
                  <h3>{engine.name}</h3>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  {engine.binary && <code className="engine-binary">{engine.binary}</code>}
                </div>
                <Badge tone={detections ? badge.tone : "neutral"}>{detections ? badge.label : "Not checked"}</Badge>
              </div>
              {detected?.version && <small className="engine-version">Version {detected.version}</small>}
              {detections && <p className="engine-readiness-message">{detected?.message ?? "This engine was not part of the last check."}</p>}
              <p>{engine.capabilities.join(" · ")}</p>
              {engine.limitations.map((limitation) => <small key={limitation}>{limitation}</small>)}
              {engine.autoEligible && <strong className="auto-safe"><Icon name="check" size={14} /> Safe for Auto</strong>}
              <EngineSetup engine={engine} {...(detected ? { detection: detected } : {})} />
            </article>;
          })}</div>
        </Card>

        <Card className="settings-section"><header><div><small>AUTONOMY</small><h2>Default behavior</h2></div></header><FormField label="New Teams start in" hint="Assist me keeps you in the loop. Work with approval pauses for risky actions. Autonomous still respects hard safety boundaries."><Select disabled={busy} value={data.preferences.defaultAutonomy} onChange={(event) => void saveAutonomy(event.target.value as Team["autonomy"])}><option value="assist">Assist me</option><option value="work-with-approval">Work with approval</option><option value="autonomous">Autonomous</option></Select></FormField></Card>

        <div className="settings-two-column"><Card className="settings-section"><header><div><small>EXTENSIONS</small><h2>Skills and Team Packs</h2></div></header><dl className="settings-facts"><div><dt>Skills</dt><dd>{data.extensions.skills}</dd></div><div><dt>Team Packs</dt><dd>{data.extensions.teamPacks.length}</dd></div></dl><a className="text-button" href="#skills">Browse Skills</a></Card><Card className="settings-section"><header><div><small>ADVANCED</small><h2>Developer diagnostics</h2></div></header><details className="advanced-options"><summary>Show technical details</summary><dl className="settings-facts">{Object.entries(data.diagnostics).map(([key, value]) => <div key={key}><dt>{key.replace(/([A-Z])/g, " $1")}</dt><dd>{value}</dd></div>)}</dl></details></Card></div>
      </div>
  </AppPage>;
};
