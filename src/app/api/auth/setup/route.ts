import { completeSetup } from "@/auth/service";
import { back, db, friendly, sameOrigin, str } from "@/web/server";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response("Forbidden", { status: 403 });
  const form = await req.formData();
  const token = str(form, "token");
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) {
    return back(`/setup/${encodeURIComponent(token)}`, { error: "The two passwords don't match." });
  }
  try {
    await completeSetup(db(), token, password);
    return back("/login", { ok: "Password saved. You can sign in now." });
  } catch (e) {
    return back(`/setup/${encodeURIComponent(token)}`, { error: friendly(e) });
  }
}
