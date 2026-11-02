import { login, SESSION_DAYS } from "@/auth/service";
import { back, db, friendly, isHttps, sameOrigin, SESSION_COOKIE, str } from "@/web/server";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response("Forbidden", { status: 403 });
  const form = await req.formData();
  try {
    const { sessionToken } = await login(db(), str(form, "email"), String(form.get("password") ?? ""));
    const res = back("/quotations");
    const secure = isHttps(req) ? "; Secure" : "";
    res.headers.append("Set-Cookie",
      `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
    return res;
  } catch (e) {
    return back("/login", { error: friendly(e) });
  }
}
