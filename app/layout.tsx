import type { ReactNode } from "react";

import "./cockpit.css";
import "./tokens.css";

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head>
        <title>Cool AI 协作驾驶舱</title>
      </head>
      <body>{children}</body>
    </html>
  );
}
