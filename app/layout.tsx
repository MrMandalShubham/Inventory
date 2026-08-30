import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Inventory Core",
  description: "One record of stock that every app can trust.",
};

export const dynamic = "force-dynamic";

/**
 * The root layout stays deliberately bare.
 *
 * /login must render without a session, so the chrome — sidebar,
 * user menu, location scope — lives in (app)/layout.tsx behind the
 * auth gate rather than here. A shell that has to null-check the
 * session on every render is a shell that will eventually leak a
 * signed-out state into a signed-in page.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
