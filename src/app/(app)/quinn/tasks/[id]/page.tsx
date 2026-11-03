/**
 * Live progress of one Quinn task: the real steps recorded by the worker (no fake progress
 * bars), then straight into the quotation editor when it's ready.
 */
import { notFound, redirect } from "next/navigation";
import { loadTaskForViewer } from "@/quinn/tasks";
import { db, requireUser } from "@/web/server";
import { AutoRefresh } from "@/web/auto-refresh";

export const metadata = { title: "Quinn is working · NewGen" };

const STATE_LABEL = { queued: "Waiting for Quinn…", running: "Quinn is preparing your quotation…", succeeded: "Done", failed: "Quinn couldn't finish" } as const;

export default async function QuinnTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser("quotes.create");
  const { id } = await params;
  const found = await loadTaskForViewer(db(), user, id);
  if (!found) notFound();
  const { task, events } = found;
  if (task.status === "succeeded" && task.quotationId) {
    redirect(`/quotations/${task.quotationId}?ok=${encodeURIComponent("Quinn has prepared this quotation. Review each section, fill in anything marked for review, then finalise.")}`);
  }
  const working = task.status === "queued" || task.status === "running";
  const elapsed = Math.round((Date.now() - task.createdAt.getTime()) / 1000);
  const time = (d: Date) => d.toLocaleTimeString("en-MY", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kuala_Lumpur" });

  return (
    <>
      <a className="back" href="/quotations">← Quotations</a>
      <div className="page-head">
        <div>
          <h1>{working && <span className="spinner" aria-hidden="true" />} {STATE_LABEL[task.status]}</h1>
          <p className="sub" aria-live="polite">{working ? `${elapsed}s so far · usually 15–60 seconds. This page updates by itself.` : null}</p>
        </div>
      </div>
      {working && <AutoRefresh />}

      {task.status === "failed" && (
        <div className="card">
          <p className="msg error" role="alert">{task.error}</p>
          <div className="actions">
            <a className="btn" href={`/quotations/generate?from=${task.id}`}>Edit and try again</a>
            <a className="btn secondary" href="/quotations/new">Create it manually instead</a>
          </div>
          {task.errorDetail && (
            <details style={{ marginTop: 14 }}><summary className="muted">Technical detail (for an Admin)</summary><p className="mono" style={{ marginTop: 8 }}>{task.errorDetail}</p></details>
          )}
        </div>
      )}

      <div className="card">
        <h2 style={{ marginBottom: 8 }}>Steps</h2>
        <ol className="steps">
          {events.map((e) => (
            <li key={e.id}><time>{time(e.at)}</time><span>{e.step === "failed" ? <strong>{e.message}</strong> : e.message}</span></li>
          ))}
          {working && <li><time>now</time><span className="muted">…</span></li>}
        </ol>
      </div>
    </>
  );
}
