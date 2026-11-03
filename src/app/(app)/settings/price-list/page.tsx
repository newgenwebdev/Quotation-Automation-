import { asc, desc } from "drizzle-orm";
import { catalogueItems } from "@/db/schema";
import { db, requireUser } from "@/web/server";
import { Messages, fmtDate, type Search } from "@/web/ui";
import { CATEGORIES, describePrice } from "@/web/catalogue-form";

export default async function PriceListPage({ searchParams }: { searchParams: Search }) {
  await requireUser("catalogue.read");
  const sp = await searchParams;
  const all = await db().select().from(catalogueItems).orderBy(asc(catalogueItems.name), desc(catalogueItems.version));
  const active = all.filter((r) => r.status === "approved");
  const drafts = all.filter((r) => r.status === "draft");
  const catLabel = Object.fromEntries(CATEGORIES);

  return (
    <>
      <Messages sp={sp} />
      <div className="card">
        <div className="card-head">
          <h2>Price list</h2>
          <a className="btn" href="/settings/price-list/new">Add service</a>
        </div>
        <p className="muted">Quinn uses these prices automatically when a requirement clearly matches a service. Anything else is marked <em>Price review required</em> for you to price. Changing a price never alters quotations already made.</p>
        {active.length === 0 ? (
          <div className="empty"><h2>No services yet</h2><p>Add your standard services so Quinn can price quotations automatically.</p></div>
        ) : (
          <div className="table-wrap" style={{ boxShadow: "none" }}>
            <table className="stack">
              <thead><tr><th>Service</th><th>Category</th><th>Price</th><th>Valid</th></tr></thead>
              <tbody>
                {active.map((r) => (
                  <tr key={r.id}>
                    <td className="lead"><a className="title" href={`/settings/price-list/${r.id}`}>{r.name}</a><div className="cell-sub mono">{r.code}</div></td>
                    <td data-label="Category">{catLabel[r.category]}</td>
                    <td data-label="Price">{describePrice(r)}</td>
                    <td data-label="Valid" className="nowrap">{fmtDate(r.validFrom)}{r.validTo ? ` – ${fmtDate(r.validTo)}` : " onwards"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {drafts.length > 0 && (
        <div className="card">
          <h2>Not in use yet</h2>
          <p className="muted">Drafts (for example indicative prices loaded by the setup script). Open one to put it into use.</p>
          <ul>{drafts.map((r) => <li key={r.id}><a href={`/settings/price-list/${r.id}`}>{r.name}</a> <span className="muted">· {describePrice(r)}</span></li>)}</ul>
        </div>
      )}
    </>
  );
}
