import type { ReactNode } from "react";

import "./cockpit.css";
import "./tokens.css";

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html
      data-theme="light"
      lang="zh-CN"
      style={{ colorScheme: "light" }}
      suppressHydrationWarning
    >
      <head>
        <script src="/theme-prepaint.js" />
        <title>Cool AI 协作驾驶舱</title>
        <link href="/manifest.webmanifest" rel="manifest" />
        <meta content="#7B3F31" name="theme-color" />
      </head>
      <body>{children}</body>
    </html>
  );
}
