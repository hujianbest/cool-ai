import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "COOL AI",
  description: "多 agent 协作平台",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
