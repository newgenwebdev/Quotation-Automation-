import { eq } from "drizzle-orm";
import { catalogueItems } from "@/db/schema";
import { db, requireUser } from "@/web/server";
import { Messages, one, type Search } from "@/web/ui";
import { CatalogueForm } from "@/web/catalogue-form";

export default async function NewCataloguePage({ searchParams }: { searchParams: Search }) {
  await requireUser("catalogue.draft");
  const sp = await searchParams;
  const fromId = one(sp.from);
  const from = fromId && /^[0-9a-f-]{36}$/.test(fromId)
    ? (await db().select().from(catalogueItems).where(eq(catalogueItems.id, fromId)))[0]
    : undefined;

  return (
    <>
      <h1>{from ? `New version of ${from.code}` : "Add a service"}</h1>
      <p className="sub">
        {from
          ? `Starts as a draft. Version ${from.version} stays in use until this one is approved.`
          : "Saved as a draft. It can't be used in quotations until another Finance or Admin person approves it."}
      </p>
      <Messages sp={sp} />
      <CatalogueForm action="/api/catalogue" item={from} lockCode={!!from} submitLabel="Save draft" />
    </>
  );
}
