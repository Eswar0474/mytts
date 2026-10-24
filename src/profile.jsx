import React, { useEffect, useMemo, useState } from 'react';
import './profile.css';

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function formatDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value || 0)));
  if (!seconds) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${remaining}s`;
}

function formatDate(value) {
  if (!value) return 'Unknown date';
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
  catch { return String(value); }
}

function statusLabel(job) {
  if (job.status === 'queued') return 'Queued';
  if (job.status === 'running') return job.progressPercent ? `Generating · ${job.progressPercent}%` : 'Generating';
  if (job.status === 'completed') return 'Completed';
  if (job.status === 'cancelled') return 'Cancelled';
  return 'Failed';
}

export default function ProfilePage() {
  const [config, setConfig] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState('');

  async function load() {
    try {
      const [configResponse, jobsResponse] = await Promise.all([
        fetch('/api/config'),
        fetch('/api/jobs')
      ]);
      const nextConfig = await configResponse.json().catch(() => ({}));
      if (!configResponse.ok) throw new Error(nextConfig.error || 'Account details could not be loaded.');
      setConfig(nextConfig);
      if (jobsResponse.status === 401) {
        setJobs([]);
        setState('signed-out');
        return;
      }
      const nextJobs = await jobsResponse.json().catch(() => ({}));
      if (!jobsResponse.ok) throw new Error(nextJobs.error || 'Audio history could not be loaded.');
      setJobs(Array.isArray(nextJobs.jobs) ? nextJobs.jobs : []);
      setState(nextConfig.auth?.signedIn ? 'ready' : 'signed-out');
      setError('');
    } catch (loadError) {
      setState('error');
      setError(loadError instanceof Error ? loadError.message : 'Audio history could not be loaded.');
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, []);

  const active = useMemo(() => jobs.some(job => job.status === 'queued' || job.status === 'running'), [jobs]);

  async function cancelJob(jobId) {
    setCancelling(jobId);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The job could not be cancelled.');
      await load();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'The job could not be cancelled.');
    } finally {
      setCancelling('');
    }
  }

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/';
  }

  return <div className="app-shell profile-shell">
    <header className="topbar"><div className="brand"><a className="profile-brand-link" href="/" aria-label="Return to Sonora studio"><span className="brand-mark">◒</span><span>sonora</span></a><span className="badge">PROFILE</span></div><div className="topbar-right"><a className="help-link" href="/">Studio</a>{config?.auth?.signedIn && <button className="account-button" onClick={signOut}>Sign out</button>}</div></header>
    <main className="profile-main">
      <section className="profile-hero"><p className="eyebrow">SONORA · ACCOUNT</p><h1>Your audio history</h1><p>Long jobs continue on the server, even when you leave the studio. Return here to watch progress and download completed files.</p></section>
      {state === 'loading' && <section className="profile-panel"><p className="profile-muted">Loading your account…</p></section>}
      {state === 'signed-out' && <section className="profile-panel"><h2>Sign in to view your history</h2><p className="profile-muted">Return to the studio and use your local username and password.</p><a className="account-button" href="/">Go to studio</a></section>}
      {state === 'error' && <section className="profile-panel"><p className="error-text" role="alert">{error}</p><button className="account-button" onClick={() => void load()}>Retry</button></section>}
      {state === 'ready' && <section className="profile-panel"><div className="profile-heading"><div><span className="step">HISTORY</span><h2>{config?.user?.username || 'Your account'}</h2></div><span className="profile-count">{jobs.length} job{jobs.length === 1 ? '' : 's'}</span></div>{error && <p className="error-text" role="alert">{error}</p>}{!jobs.length ? <div className="profile-empty"><h3>No audio jobs yet</h3><p>Start a long-audio generation in the studio and it will appear here.</p><a className="account-button" href="/">Open studio</a></div> : <div className="job-list">{jobs.map(job => <article className="job-card" key={job.id}><div className="job-card-top"><div><h3>{job.title}</h3><p>{formatDate(job.createdAt)} · {job.outputFormat.toUpperCase()} · {formatDuration(job.durationSeconds)}</p></div><span className={`job-status job-status-${job.status}`}>{statusLabel(job)}</span></div>{(job.status === 'queued' || job.status === 'running') && <div className="job-progress"><div className="progress-caption"><span>{job.completedChunks.toLocaleString()} of {job.totalChunks.toLocaleString()} segments</span><strong>{job.progressPercent}%</strong></div><progress value={job.progressPercent} max="100" aria-label={`${job.title} progress`} /></div>}{job.status === 'completed' && <div className="job-complete"><p>{formatBytes(job.totalAudioBytes)} · ready to download</p><audio controls preload="none" src={`/api/jobs/${encodeURIComponent(job.id)}/download?inline=1`} aria-label={`Preview ${job.title}`} /><a className="download-button" href={`/api/jobs/${encodeURIComponent(job.id)}/download`} download>Download {job.outputFormat.toUpperCase()} ↓</a></div>}{job.status === 'failed' && <p className="error-text">{job.errorMessage || 'The job failed. Start it again from the studio.'}</p>}{(job.status === 'queued' || job.status === 'running') && <button className="cancel-button" disabled={cancelling === job.id} onClick={() => void cancelJob(job.id)}>{cancelling === job.id ? 'Cancelling…' : 'Cancel job'}</button>}</article>)}</div>}{active && <p className="profile-muted profile-refresh-note">This page refreshes active jobs automatically.</p>}</section>}
    </main>
  </div>;
}
