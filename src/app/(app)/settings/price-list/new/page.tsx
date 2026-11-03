import { eq } from "drizzle-orm";
import { catalogueItems } from "@/db/schema";
import { db, requireUser } from "@/web/server";
import { Messages, one, type Search } from "@/web/ui";
import { CatalogueForm } from "@/web/catalogue-form";

export default async function NewServicePage({ searchParams }: { searchParams: Search }) {
  await requireUser("catalogue.manage");
  const sp = await searchParams;
  const fromId = one(sp.from);
  const from = fromId && /^[0-9a-f-]{36}$/.test(fromId)
    ? (await db().select().from(catalogueItems).where(eq(catalogueItems.id, fromId)))[0]
    : undefined;
  return (
    <>
      <a className="back" href="/settings/price-list">← Price list</a>
      <h2 style={{ fontSize: 17, marginBottom: 4 }}>{from ? `Change ${from.name}` : "Add a service"}</h2>
      <p className="muted">{from ? "Saving creates a new version that is used from now on. Quotations already made keep the old price." : "Used for new quotations as soon as you save."}</p>
      <Messages sp={sp} />
      <CatalogueForm action="/api/catalogue" item={from} lockCode={!!from} submitLabel={from ? "Save new price" : "Save service"} />
    </>
  );
}
