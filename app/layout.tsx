import type { ReactNode } from "react";

import "./cockpit.css";
import "./tokens.css";

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
