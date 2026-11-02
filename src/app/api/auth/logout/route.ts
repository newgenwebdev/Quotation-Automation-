import { logout } from "@/auth/service";
import { back, db, sameOrigin, SESSION_COOKIE } from "@/web/server";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response("Forbidden", { status: 403 });
  const token = req.headers.get("cookie")?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
  await logout(db(), token);
  const res = back("/login", { ok: "Signed out." });
  res.headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res;
}
