import type { ReactNode } from "react";

export const metadata = {
  title: "Tee Times",
  description: "Personal golf tee-time metasearch (no accounts)",
};

/** Root layout for the shared, no-account search app (A2). */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
