import { redirect } from "next/navigation";
import { optionalUser } from "@/web/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "No access · NewGen" };

/** Shown to a signed-in account that has no permissions (only possible if changed by hand in the database). */
export default async function NoAccessPage() {
  const user = await optionalUser();
  if (!user) redirect("/login");
  return (
    <div className="center">
      <img className="logo" src="/brand/newgen-logo.png" alt="NewGen" width={126} height={30} />
      <div className="card">
        <h1 style={{ fontSize: 19 }}>No access</h1>
        <p className="muted">Your account ({user.email}) can&apos;t use the quotation system. Ask an Admin to check your account in Settings → Users.</p>
        <form method="post" action="/api/auth/logout"><button type="submit" className="secondary">Sign out</button></form>
      </div>
    </div>
  );
}
