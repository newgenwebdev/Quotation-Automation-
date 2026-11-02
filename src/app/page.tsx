import { redirect } from "next/navigation";
import { optionalUser } from "@/web/server";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await optionalUser();
  redirect(user ? "/quotations" : "/login");
}
