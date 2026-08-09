import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => {
    const [pathname, setPathname] = useState(() => window.location.pathname);
    useEffect(() => {
      const syncPathname = () => setPathname(window.location.pathname);
      window.addEventListener("popstate", syncPathname);
      return () => window.removeEventListener("popstate", syncPathname);
    }, []);
    return pathname;
  },
  useRouter: () => {
    const navigate = (href: string, replace: boolean) => {
      window.history[replace ? "replaceState" : "pushState"](null, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
    return {
      back: vi.fn(() => window.history.back()),
      push: vi.fn((href: string) => navigate(href, false)),
      replace: vi.fn((href: string) => navigate(href, true)),
    };
  },
}));

afterEach(() => {
  if (typeof window === "undefined") {
    return;
  }
  cleanup();
  window.history.replaceState(null, "", "/");
});
