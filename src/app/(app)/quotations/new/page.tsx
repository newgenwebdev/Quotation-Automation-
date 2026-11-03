import { db, requireUser } from "@/web/server";
import { QuoteEditor } from "@/web/editor/QuoteEditor";
import { blankState } from "@/web/editor/model";
import { editorContext } from "@/web/editor/context";

export const metadata = { title: "New quotation · NewGen" };

export default async function NewQuotationPage() {
  const user = await requireUser("quotes.create");
  const ctx = await editorContext(db());
  return (
    <QuoteEditor
      initial={blankState(ctx.defaults)} createdBy={user.name} priceList={ctx.priceList} templates={ctx.templates}
      previousTerms={[]} aiNotes={null} validityDays={ctx.validityDays} today={ctx.today}
    />
  );
}
