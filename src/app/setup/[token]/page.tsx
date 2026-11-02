import { Messages, type Search } from "@/web/ui";
import { MIN_PASSWORD_LENGTH } from "@/auth/service";

export const dynamic = "force-dynamic";

export default async function SetupPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Search }) {
  const { token } = await params;
  const sp = await searchParams;
  return (
    <div className="center">
      <h1>Set your password</h1>
      <p className="sub">This link works once. Choose a password only you know.</p>
      <Messages sp={sp} />
      <form method="post" action="/api/auth/setup" className="panel">
        <input type="hidden" name="token" value={token} />
        <label htmlFor="password">New password <span className="hint">(at least {MIN_PASSWORD_LENGTH} characters)</span></label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required />
        <label htmlFor="confirm">Type it again</label>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required />
        <p><button type="submit">Save password</button></p>
      </form>
    </div>
  );
}
