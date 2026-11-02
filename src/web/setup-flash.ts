/** Hands a freshly created setup link to the Users page once, via a short-lived cookie (not the URL). */
export const SETUP_FLASH_COOKIE = "ngo_setup_link";

export function withSetupFlash(res: Response, name: string, token: string, secure: boolean): Response {
  res.headers.append("Set-Cookie",
    `${SETUP_FLASH_COOKIE}=${encodeURIComponent(`${name}\n${token}`)}; Path=/users; HttpOnly; SameSite=Strict; Max-Age=60${secure ? "; Secure" : ""}`);
  return res;
}
