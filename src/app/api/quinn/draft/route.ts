import { createDraftTask } from "@/quinn/tasks";
import { enqueueDraftTask } from "@/quinn/queue";
import { quinnConfigured } from "@/quinn/ai";
import { back, db, formHandler, str } from "@/web/server";

export const POST = formHandler({ permission: "quotes.create", errorPath: "/quotations/generate" }, async ({ user, form }) => {
  if (!quinnConfigured()) {
    return back("/quotations/generate", { error: "Quinn isn't connected to OpenAI yet. An Admin needs to add OPENAI_API_KEY in Dokploy." });
  }
  const task = await createDraftTask(db(), user, {
    description: String(form.get("description") ?? ""),
    clientCompany: str(form, "clientCompany"),
  });
  await enqueueDraftTask(task.id);
  return back(`/quinn/tasks/${task.id}`);
});
