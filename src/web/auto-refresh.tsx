"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-checks the page every couple of seconds while Quinn is working. */
export function AutoRefresh({ ms = 2000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [router, ms]);
  return null;
}
