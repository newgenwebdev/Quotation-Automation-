import { redirect } from "next/navigation";
import { optionalUser } from "@/web/server";
import { Messages, type Search } from "@/web/ui";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  if (await optionalUser()) redirect("/catalogue");
  const sp = await searchParams;
  return (
    <div className="center">
      <h1>NewGen AI Office</h1>
      <p className="sub">Sign in to continue</p>
      <Messages sp={sp} />
      <form method="post" action="/api/auth/login" className="panel">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        <p><button type="submit">Sign in</button></p>
      </form>
      <p className="muted">No account or forgot your password? Ask an Admin for a setup link.</p>
    </div>
  );
}
