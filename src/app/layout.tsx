import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Socialbear AI — Moderation Panel",
  description:
    "Socialbear AI for social inbox moderation. Manage keywords, thresholds, categories, and logs.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface-50">{children}</body>
    </html>
  );
}
