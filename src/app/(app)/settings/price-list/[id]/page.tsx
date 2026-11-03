import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { catalogueItems } from "@/db/schema";
import { userNames } from "@/quotations/service";
import { db, requireUser } from "@/web/server";
import { List, Messages, Status, fmtDate, fmtDateTime, type Search } from "@/web/ui";
import { CATEGORIES, describePrice } from "@/web/catalogue-form";

const STATUS_LABEL = { approved: "In use", draft: "Not in use yet", retired: "Replaced / removed" } as const;

export default async function ServicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  await requireUser("catalogue.read");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [item] = await db().select().from(catalogueItems).where(eq(catalogueItems.id, id));
  if (!item) notFound();
  const versions = await db().select().from(catalogueItems).where(eq(catalogueItems.code, item.code)).orderBy(desc(catalogueItems.version));
  const names = await userNames(db(), versions.flatMap((v) => [v.createdBy, v.approvedBy]));
  const catLabel = Object.fromEntries(CATEGORIES);

  return (
    <>
      <a className="back" href="/settings/price-list">← Price list</a>
      <Messages sp={sp} />
      <div className="card">
        <div className="card-head">
          <div>
            <h2 style={{ fontSize: 17 }}>{item.name} <span className="muted" style={{ fontWeight: 400 }}>v{item.version}</span></h2>
            <div className="mono muted">{item.code}</div>
          </div>
          <Status status={item.status === "approved" ? "active" : item.status} label={STATUS_LABEL[item.status]} />
        </div>
        <div className="grid">
          <div><div className="label">Price</div>{describePrice(item)}</div>
          <div><div className="label">Category</div>{catLabel[item.category]}</div>
          <div><div className="label">Valid</div>{fmtDate(item.validFrom)}{item.validTo ? ` – ${fmtDate(item.validTo)}` : " onwards"}</div>
          <div><div className="label">Revision rounds</div>{item.revisionLimit ?? <span className="muted">Not stated</span>}</div>
        </div>
        <div className="grid-2" style={{ marginTop: 14 }}>
          <div><div className="label">Included</div><List items={item.inclusions} empty="Not listed" /></div>
          <div><div className="label">Not included</div><List items={item.exclusions} empty="Not listed" /></div>
        </div>
        {item.notes && <><div className="label" style={{ marginTop: 12 }}>Internal notes</div><p className="pre">{item.notes}</p></>}
        <p className="muted small" style={{ marginTop: 12 }}>Saved by {names[item.createdBy] ?? "—"} on {fmtDateTime(item.approvedAt ?? item.createdAt)}</p>
        <div className="actions">
          {item.status === "approved" && <a className="btn" href={`/settings/price-list/new?from=${item.id}`}>Change price or details</a>}
          {item.status === "draft" && (
            <form method="post" action={`/api/catalogue/${item.id}/publish`}><button type="submit">Put into use</button></form>
          )}
        </div>
      </div>

      {item.status === "approved" && (
        <details className="card">
          <summary style={{ cursor: "pointer", fontWeight: 650 }}>Remove from the price list</summary>
          <form method="post" action={`/api/catalogue/${item.id}/retire`} style={{ marginTop: 12 }}>
            <label htmlFor="retire-reason">Reason</label>
            <div className="row">
              <input id="retire-reason" name="reason" required minLength={3} placeholder="e.g. Service discontinued" style={{ flex: 1, minWidth: 220 }} />
              <button type="submit" className="danger">Remove</button>
            </div>
            <p className="muted small" style={{ marginTop: 6 }}>Quotations that already use it are not affected.</p>
          </form>
        </details>
      )}

      {versions.length > 1 && (
        <div className="card">
          <h2>Price history</h2>
          <div className="table-wrap" style={{ boxShadow: "none", marginTop: 10 }}>
            <table>
              <thead><tr><th>Version</th><th>Price</th><th>Status</th><th>Saved</th></tr></thead>
              <tbody>{versions.map((v) => (
                <tr key={v.id}>
                  <td><a href={`/settings/price-list/${v.id}`}>v{v.version}</a></td>
                  <td>{describePrice(v)}</td>
                  <td><Status status={v.status === "approved" ? "active" : v.status} label={STATUS_LABEL[v.status]} /></td>
                  <td className="nowrap">{fmtDateTime(v.approvedAt ?? v.createdAt)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
