/**
 * Live progress of one Quinn task. Shows the real steps recorded by the worker (no fake
 * progress bars), then jumps straight to the draft quotation when it's ready.
 */
import { notFound, redirect } from "next/navigation";
import { loadTaskForViewer } from "@/quinn/tasks";
import { db, requireUser } from "@/web/server";
import { fmtDateTime } from "@/web/ui";
import { AutoRefresh } from "@/web/auto-refresh";

const STATE_LABEL = { queued: "Waiting for Quinn…", running: "Quinn is working…", succeeded: "Done", failed: "Quinn couldn't finish" } as const;

export default async function QuinnTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const found = await loadTaskForViewer(db(), user, id);
  if (!found) notFound();
  const { task, events } = found;
  if (task.status === "succeeded" && task.quotationId) {
    redirect(`/quotations/${task.quotationId}?ok=${encodeURIComponent("Quinn drafted this quotation. Check it, fill in any missing prices, then submit to Finance.")}`);
  }
  const working = task.status === "queued" || task.status === "running";
  const elapsed = Math.round((Date.now() - task.createdAt.getTime()) / 1000);

  return (
    <>
      <p><a href="/quotations">← Quotations</a></p>
      <h1>{STATE_LABEL[task.status]}</h1>
      <p className="sub">Requested {fmtDateTime(task.createdAt)}{working ? ` · ${elapsed}s so far (usually under a minute)` : ""}</p>
      {working && <AutoRefresh />}

      {task.status === "failed" && (
        <div className="panel">
          <p className="msg error" style={{ marginBottom: 12 }}>{task.error}</p>
          <div className="actions">
            <a className="btn" href={`/quotations/generate?from=${task.id}`}>Edit and try again</a>
            <a className="btn secondary" href="/quotations/new">Create it manually instead</a>
          </div>
          {user.role === "admin" && task.errorDetail && (
            <details style={{ marginTop: 12 }}><summary className="muted">Technical detail (Admins only)</summary><p className="mono">{task.errorDetail}</p></details>
          )}
        </div>
      )}

      <h2>Steps</h2>
      <table>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td style={{ width: 170 }} className="muted">{fmtDateTime(e.at)}</td>
              <td>{e.step === "failed" ? <strong>{e.message}</strong> : e.message}</td>
            </tr>
          ))}
          {working && <tr><td className="muted">now</td><td className="muted">…</td></tr>}
        </tbody>
      </table>
    </>
  );
}
