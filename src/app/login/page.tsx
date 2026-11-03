import { redirect } from "next/navigation";
import { optionalUser } from "@/web/server";
import { Messages, type Search } from "@/web/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · NewGen" };

export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  if (await optionalUser()) redirect("/quotations");
  const sp = await searchParams;
  return (
    <div className="center">
      <img className="logo" src="/brand/newgen-logo.png" alt="NewGen" width={126} height={30} />
      <div className="card">
        <h1 style={{ fontSize: 19 }}>Sign in</h1>
        <p className="muted">NewGen quotations · Quinn</p>
        <Messages sp={sp} />
        <form method="post" action="/api/auth/login">
          <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="username" required /></div>
          <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required /></div>
          <button type="submit" style={{ width: "100%" }}>Sign in</button>
        </form>
      </div>
      <p className="muted small">No account or forgot your password? Ask an Admin for a setup link.</p>
    </div>
  );
}
