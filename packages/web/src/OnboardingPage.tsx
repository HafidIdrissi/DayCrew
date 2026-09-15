import * as React from "react";
import { useEffect, useState } from "react";

import { detectEngines, installStarterTeam, listTeams, loadSettings, startGoal, updateTeamMember } from "./api";
import { AppSidebar, Avatar, Icon, MemberStatusBadge } from "./components";
import type { EngineDetection, SettingsData, Team } from "./types";
import { Badge, Button, Card, ErrorState, LoadingState } from "./ui";

export const OnboardingPage = ({ selectionId }: { selectionId: string }) => {
  /** Each Mission template carries its own short tile label; the brief stays the full sentence. */
  const templates = [
    { label: "Launch a landing page", brief: "Launch a landing page with a clear value proposition and test the main user journey." },
    { label: "Fix the top bug", brief: "Reproduce and fix the most important bug, then verify the regression." },
    { label: "Audit security risks", brief: "Audit the project for its highest-impact security risks and propose concrete fixes." },
    { label: "Prepare a release", brief: "Prepare a release: validate the build, summarize changes, and produce a release checklist." },
  ];
  const [settings, setSettings] = useState<SettingsData>();
  const [team, setTeam] = useState<Team>();
  const [detections, setDetections] = useState<EngineDetection[]>([]);
  const [step, setStep] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [goal, setGoal] = useState(templates[0]!.brief);
  useEffect(() => { void Promise.all([loadSettings(selectionId), listTeams(selectionId)]).then(([next, teams]) => { setSettings(next); if (teams[0]) { setTeam(teams[0]); setStep(6); } }).catch((caught) => setError(caught instanceof Error ? caught.message : "Onboarding could not start.")); }, [selectionId]);
  const detect = async () => { setBusy(true); setError(undefined); try { setDetections(await detectEngines(selectionId)); setStep(4); } catch (caught) { setError(caught instanceof Error ? caught.message : "AI Engine detection failed."); } finally { setBusy(false); } };
  const create = async () => { setBusy(true); setError(undefined); try { const next = await installStarterTeam(selectionId); setTeam(next); setStep(6); } catch (caught) { setError(caught instanceof Error ? caught.message : "DayCrew could not create the Team."); } finally { setBusy(false); } };
  const launch = async (demo: boolean) => {
    if (!team || !goal.trim()) return;
    setBusy(true); setError(undefined);
    try {
      if (demo) {
        await Promise.all(team.members.map((member) => updateTeamMember(team.id, member.id, {
          name: member.name, role: member.role, instructions: member.instructions,
          engine: { mode: "manual", provider: "demo" },
        }, selectionId)));
      }
      await startGoal(team.id, goal.trim(), selectionId);
      window.location.hash = `teams/${team.id}`;
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The Manager could not start this Mission."); }
    finally { setBusy(false); }
  };
  const submitGoal = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); await launch(false); };
  if (!settings && !error) return <div className="app-frame"><AppSidebar needsCount={0} /><main className="app-main state-main"><LoadingState label="Preparing your Workspace..." /></main></div>;
  if (!settings) return <div className="app-frame"><AppSidebar needsCount={0} /><main className="app-main state-main"><ErrorState message={error ?? "Onboarding is unavailable."} /></main></div>;
  const manager = team?.members.find((member) => member.isManager);
  return <div className="app-frame"><AppSidebar needsCount={0} activeView="Team" /><main className="app-main"><div className="onboarding-shell"><header><a className="brand" href="#home"><Icon name="logo" size={34} /><span>DayCrew</span></a><button className="text-button" onClick={() => { window.location.hash = "home"; }}>Finish later</button></header><div className="onboarding-progress" aria-label="Onboarding progress">{["Welcome", "Workspace", "AI Engines", "Team", "Team Pack", "Crew", "First Goal"].map((label, index) => <span className={step >= index + 1 ? "complete" : ""} key={label}><i>{step > index + 1 ? "✓" : index + 1}</i>{label}</span>)}</div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {step === 3 && <Card className="onboarding-card"><small>STEP 3 OF 7</small><h1>Detect AI Engines</h1><p>DayCrew checks which engine command-line tools are installed and signed in on this machine. No account or credential is sent anywhere, and DayCrew never asks for an API key.</p><div className="onboarding-actions"><Button disabled={busy} onClick={() => void detect()}>{busy ? "Checking..." : "Detect AI Engines"}</Button><Button variant="text" onClick={() => setStep(4)}>Skip for now</Button></div></Card>}
    {step === 4 && <Card className="onboarding-card"><small>STEP 4 OF 7</small><h1>Create your first Team</h1><p>Start with the focused Software Development Team Pack. You can create custom Teams later.</p>{detections.length > 0 && <div className="detection-summary">{detections.map((item) => <Badge tone={item.ready ? "success" : "neutral"} key={item.id}>{item.id}: {item.message}</Badge>)}</div>}<Button onClick={() => setStep(5)}>Choose Team Pack</Button></Card>}
    {step === 5 && <Card className="onboarding-card"><small>STEP 5 OF 7</small><h1>Software Development</h1><p>Engineering Manager, Software Architect, Developer, and QA Engineer. Work with approval is enabled by default.</p><div className="pack-preview"><Icon name="team" size={28} /><span><strong>Software Development</strong><small>Manager + 3 specialists</small></span></div><Button disabled={busy} onClick={() => void create()}>{busy ? "Creating Team..." : "Use this Team Pack"}</Button></Card>}
    {step === 6 && team && <Card className="onboarding-card wide"><small>STEP 6 OF 7</small><h1>Review your crew</h1><p>The Manager coordinates the specialists. Each Member starts on the safe Auto engine policy.</p><div className="crew-review">{team.members.map((member) => <article key={member.id}><Avatar member={member} size="sm" /><div><strong>{member.name}</strong><small>{member.role}</small></div><MemberStatusBadge status="idle" /></article>)}</div><Button onClick={() => setStep(7)}>Continue to first Goal</Button></Card>}
    {step === 7 && team && manager && <Card className="onboarding-card wide"><small>STEP 7 OF 7</small><h1>Launch your first Mission</h1><p>Pick a useful starting point or write your own brief. Watch the Manager plan, assign three Tasks, request a decision, and report the result.</p><div className="mission-template-grid" aria-label="Mission templates">{templates.map((template) => <button type="button" className={goal === template.brief ? "active" : ""} onClick={() => setGoal(template.brief)} disabled={busy} key={template.label}>{template.label}</button>)}</div><form className="onboarding-goal" onSubmit={submitGoal}><label><span>Mission brief for {manager.name}</span><textarea name="goal" value={goal} onChange={(event) => setGoal(event.target.value)} disabled={busy} /></label><div className="onboarding-launch-actions"><Button disabled={busy || !goal.trim()}>{busy ? "Starting Mission..." : "Start with my AI Engines"}</Button><Button type="button" variant="secondary" disabled={busy || !goal.trim()} onClick={() => void launch(true)}>Run guided demo</Button></div></form><p className="onboarding-demo-note"><strong>Guided demo</strong> uses transparent simulated output, costs nothing, and creates real DayCrew session, Task, activity, and Needs You records.</p><Button variant="text" onClick={() => { window.location.hash = `teams/${team.id}`; }}>Open Team without starting</Button></Card>}
  </div></main></div>;
};
