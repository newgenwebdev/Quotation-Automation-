import { asc, desc } from "drizzle-orm";
import { catalogueItems } from "@/db/schema";
import { can } from "@/auth/permissions";
import { db, requireUser } from "@/web/server";
import { Messages, Status, fmtDate, type Search } from "@/web/ui";
import { CATEGORIES, describePrice } from "@/web/catalogue-form";

export default async function CataloguePage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser("catalogue.read");
  const sp = await searchParams;
  const seeDrafts = can(user, "catalogue.viewDrafts");
  const all = await db().select().from(catalogueItems).orderBy(asc(catalogueItems.code), desc(catalogueItems.version));
  // Sales and Technical only ever see approved prices. Drafts stay private to Finance/Admin.
  const rows = seeDrafts ? all.filter((r) => r.status !== "retired") : all.filter((r) => r.status === "approved");
  const catLabel = Object.fromEntries(CATEGORIES);

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Price list</h1>
          <p className="sub">{seeDrafts ? "Approved prices and drafts awaiting approval." : "Finance-approved prices you can quote."}</p>
        </div>
        {can(user, "catalogue.draft") && <a className="btn" href="/catalogue/new">Add service</a>}
      </div>
      <Messages sp={sp} />
      {rows.length === 0 ? (
        <div className="panel">
          <p><strong>No {seeDrafts ? "" : "approved "}prices yet.</strong></p>
          <p className="muted">{can(user, "catalogue.draft")
            ? "Add your first service. It starts as a draft, and a second Finance or Admin person approves it."
            : "Finance hasn't approved any prices yet."}</p>
        </div>
      ) : (
        <table>
          <thead><tr><th>Code</th><th>Service</th><th>Category</th><th>Price</th><th>Status</th><th>Valid</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono"><a href={`/catalogue/${r.id}`}>{r.code}</a> <span className="muted">v{r.version}</span></td>
                <td>{r.name}{r.kind === "add_on" && <span className="muted"> · add-on</span>}</td>
                <td>{catLabel[r.category]}</td>
                <td>{describePrice(r)}</td>
                <td><Status status={r.status} /></td>
                <td>{fmtDate(r.validFrom)}{r.validTo ? ` – ${fmtDate(r.validTo)}` : " onwards"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
