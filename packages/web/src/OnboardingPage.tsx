import * as React from "react";
import { useEffect, useState } from "react";

import { detectEngines, installStarterTeam, listTeams, loadSettings, startGoal } from "./api";
import { AppSidebar, Avatar, Icon, MemberStatusBadge } from "./components";
import type { EngineDetection, SettingsData, Team } from "./types";
import { Badge, Button, Card, ErrorState, LoadingState } from "./ui";

export const OnboardingPage = ({ selectionId }: { selectionId: string }) => {
  const [settings, setSettings] = useState<SettingsData>();
  const [team, setTeam] = useState<Team>();
  const [detections, setDetections] = useState<EngineDetection[]>([]);
  const [step, setStep] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { void Promise.all([loadSettings(selectionId), listTeams(selectionId)]).then(([next, teams]) => { setSettings(next); if (teams[0]) { setTeam(teams[0]); setStep(6); } }).catch((caught) => setError(caught instanceof Error ? caught.message : "Onboarding could not start.")); }, [selectionId]);
  const detect = async () => { setBusy(true); setError(undefined); try { setDetections(await detectEngines(selectionId)); setStep(4); } catch (caught) { setError(caught instanceof Error ? caught.message : "AI Engine detection failed."); } finally { setBusy(false); } };
  const create = async () => { setBusy(true); setError(undefined); try { const next = await installStarterTeam(selectionId); setTeam(next); setStep(6); } catch (caught) { setError(caught instanceof Error ? caught.message : "DayCrew could not create the Team."); } finally { setBusy(false); } };
  const submitGoal = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!team) return; const goal = String(new FormData(event.currentTarget).get("goal") ?? "").trim(); if (!goal) return; setBusy(true); setError(undefined); try { await startGoal(team.id, goal, selectionId); window.location.hash = `teams/${team.id}`; } catch (caught) { setError(caught instanceof Error ? caught.message : "The Manager could not start this Goal."); } finally { setBusy(false); } };
  if (!settings && !error) return <div className="app-frame"><AppSidebar needsCount={0} /><main className="app-main state-main"><LoadingState label="Preparing your Workspace..." /></main></div>;
  if (!settings) return <div className="app-frame"><AppSidebar needsCount={0} /><main className="app-main state-main"><ErrorState message={error ?? "Onboarding is unavailable."} /></main></div>;
  const manager = team?.members.find((member) => member.isManager);
  return <div className="app-frame"><AppSidebar needsCount={0} activeView="Team" /><main className="app-main"><div className="onboarding-shell"><header><a className="brand" href="#home"><Icon name="logo" size={34} /><span>DayCrew</span></a><button className="text-button" onClick={() => { window.location.hash = "home"; }}>Finish later</button></header><div className="onboarding-progress" aria-label="Onboarding progress">{["Welcome", "Workspace", "AI Engines", "Team", "Team Pack", "Crew", "First Goal"].map((label, index) => <span className={step >= index + 1 ? "complete" : ""} key={label}><i>{step > index + 1 ? "✓" : index + 1}</i>{label}</span>)}</div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {step === 3 && <Card className="onboarding-card"><small>STEP 3 OF 7</small><h1>Detect AI Engines</h1><p>DayCrew checks which engine command-line tools are installed and signed in on this machine. No account or credential is sent anywhere, and DayCrew never asks for an API key.</p><div className="onboarding-actions"><Button disabled={busy} onClick={() => void detect()}>{busy ? "Checking..." : "Detect AI Engines"}</Button><Button variant="text" onClick={() => setStep(4)}>Skip for now</Button></div></Card>}
    {step === 4 && <Card className="onboarding-card"><small>STEP 4 OF 7</small><h1>Create your first Team</h1><p>Start with the focused Software Development Team Pack. You can create custom Teams later.</p>{detections.length > 0 && <div className="detection-summary">{detections.map((item) => <Badge tone={item.ready ? "success" : "neutral"} key={item.id}>{item.id}: {item.message}</Badge>)}</div>}<Button onClick={() => setStep(5)}>Choose Team Pack</Button></Card>}
    {step === 5 && <Card className="onboarding-card"><small>STEP 5 OF 7</small><h1>Software Development</h1><p>Engineering Manager, Software Architect, Developer, and QA Engineer. Work with approval is enabled by default.</p><div className="pack-preview"><Icon name="team" size={28} /><span><strong>Software Development</strong><small>Manager + 3 specialists</small></span></div><Button disabled={busy} onClick={() => void create()}>{busy ? "Creating Team..." : "Use this Team Pack"}</Button></Card>}
    {step === 6 && team && <Card className="onboarding-card wide"><small>STEP 6 OF 7</small><h1>Review your crew</h1><p>The Manager coordinates the specialists. Each Member starts on the safe Auto engine policy.</p><div className="crew-review">{team.members.map((member) => <article key={member.id}><Avatar member={member} size="sm" /><div><strong>{member.name}</strong><small>{member.role}</small></div><MemberStatusBadge status="idle" /></article>)}</div><Button onClick={() => setStep(7)}>Continue to first Goal</Button></Card>}
    {step === 7 && team && manager && <Card className="onboarding-card"><small>STEP 7 OF 7</small><h1>Give your Manager a Goal</h1><p>Start with a concrete outcome. Your Team will create Tasks and surface only decisions that need you.</p><form className="onboarding-goal" onSubmit={submitGoal}><label><span>Goal for {manager.name}</span><textarea name="goal" defaultValue="Create a hello endpoint and review the implementation." disabled={busy} /></label><Button disabled={busy}>{busy ? "Starting work..." : "Start first Goal"}</Button></form><Button variant="text" onClick={() => { window.location.hash = `teams/${team.id}`; }}>Open Team without starting</Button></Card>}
  </div></main></div>;
};
