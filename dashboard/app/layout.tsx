import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "CrossTalk — Điều phối voice",
  description: "Dashboard quản trị Discord CrossTalk",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
