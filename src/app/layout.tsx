import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "NewGen AI Office", robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
