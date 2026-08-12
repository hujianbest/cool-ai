import { afterEach, vi } from "vitest";

vi.mock("next/navigation", async () => {
  const { useEffect, useState } = await import("react");
  return {
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
  };
});

// DOM-only setup is imported lazily so pure node-environment files do not pay
// the React/testing-library/jsdom import cost in their worker.
if (typeof window !== "undefined") {
  const [{ cleanup }] = await Promise.all([
    import("@testing-library/react"),
    import("@testing-library/jest-dom/vitest"),
  ]);
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  // Setup localStorage for jsdom tests
  const { JSDOM } = await import("jsdom");
  if (typeof localStorage === "undefined") {
    const jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "http://localhost",
    });
    global.localStorage = jsdom.window.localStorage;
  }
}
