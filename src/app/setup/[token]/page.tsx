import { Messages, type Search } from "@/web/ui";
import { MIN_PASSWORD_LENGTH } from "@/auth/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set your password · NewGen" };

export default async function SetupPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Search }) {
  const { token } = await params;
  const sp = await searchParams;
  return (
    <div className="center">
      <img className="logo" src="/brand/newgen-logo.png" alt="NewGen" width={126} height={30} />
      <div className="card">
        <h1 style={{ fontSize: 19 }}>Set your password</h1>
        <p className="muted">This link works once. Choose a password only you know.</p>
        <Messages sp={sp} />
        <form method="post" action="/api/auth/setup">
          <input type="hidden" name="token" value={token} />
          <div className="field"><label htmlFor="password">New password <span className="hint">· at least {MIN_PASSWORD_LENGTH} characters</span></label>
            <input id="password" name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required /></div>
          <div className="field"><label htmlFor="confirm">Type it again</label>
            <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required /></div>
          <button type="submit" style={{ width: "100%" }}>Save password</button>
        </form>
      </div>
    </div>
  );
}
