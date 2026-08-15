import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

export function useNarrowMode(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const breakpoint = window
      .getComputedStyle(document.documentElement)
      .getPropertyValue("--breakpoint-cockpit")
      .trim();
    const query = window.matchMedia(`(max-width: ${breakpoint})`);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

type ModalSurfaceOptions = {
  active: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  hideBackground?: boolean;
  inertRootRefs: Array<RefObject<HTMLElement | null>>;
  initialFocusRef: RefObject<HTMLElement | null>;
  restoreFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
};

const EMPTY_SELECTORS: string[] = [];

// body overflow is a single global resource shared by every modal surface;
// layered surfaces (drawer paused under a dialog) hand the lock off without
// restoring a stale value, so only the last unlock restores the pre-lock state.
let overflowLockCount = 0;
let overflowBeforeFirstLock = "";

function lockBodyOverflow(): void {
  if (overflowLockCount === 0) {
    overflowBeforeFirstLock = document.body.style.overflow;
  }
  overflowLockCount += 1;
  document.body.style.overflow = "hidden";
}

function unlockBodyOverflow(): void {
  overflowLockCount = Math.max(0, overflowLockCount - 1);
  if (overflowLockCount === 0) {
    document.body.style.overflow = overflowBeforeFirstLock;
  }
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("hidden"));
}

export function useModalSurface(options: ModalSurfaceOptions): void;
export function useModalSurface(
  active: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  inertSelectors: string[],
): void;
export function useModalSurface(
  optionsOrActive: ModalSurfaceOptions | boolean,
  legacyDialogRef?: RefObject<HTMLElement | null>,
  legacyInertSelectors: string[] = EMPTY_SELECTORS,
): void {
  const options =
    typeof optionsOrActive === "boolean"
      ? null
      : optionsOrActive;
  const active = options?.active ?? optionsOrActive === true;
  const dialogRef = options?.dialogRef ?? legacyDialogRef!;
  const activeRef = useRef(active);
  activeRef.current = active;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!active) return;
    const currentOptions = optionsRef.current;
    const inertElements = currentOptions
      ? currentOptions.inertRootRefs.flatMap((reference) =>
          reference.current ? [reference.current] : [],
        )
      : legacyInertSelectors.flatMap((selector) =>
          Array.from(document.querySelectorAll<HTMLElement>(selector)),
        );
    const previousAccessibility = inertElements.map((element) => ({
      ariaHidden: element.getAttribute("aria-hidden"),
      element,
      inert: element.hasAttribute("inert"),
    }));
    inertElements.forEach((element) => {
      element.setAttribute("inert", "");
      if (currentOptions?.hideBackground) {
        element.setAttribute("aria-hidden", "true");
      }
    });
    lockBodyOverflow();

    const dialog = dialogRef.current;
    let cancelled = false;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const latest = optionsRef.current;
      if (event.key === "Escape" && latest) {
        event.preventDefault();
        latest.onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog?.addEventListener("keydown", handleKeyDown);
    queueMicrotask(() => {
      if (cancelled) return;
      const surface = dialogRef.current;
      // A resuming surface (e.g. the narrow drawer resuming after a layered
      // dialog closes) must not yank focus away from a control already inside
      // it — the closing dialog's own restore target wins.
      if (surface?.contains(document.activeElement)) return;
      const latest = optionsRef.current;
      const initialFocus =
        latest?.initialFocusRef.current ??
        surface?.querySelector<HTMLElement>(
          '[data-dialog-close="true"]',
        );
      initialFocus?.focus();
    });
    return () => {
      cancelled = true;
      dialog?.removeEventListener("keydown", handleKeyDown);
      previousAccessibility.forEach(({ ariaHidden, element, inert }) => {
        if (!inert) element.removeAttribute("inert");
        if (currentOptions?.hideBackground) {
          if (ariaHidden === null) element.removeAttribute("aria-hidden");
          else element.setAttribute("aria-hidden", ariaHidden);
        }
      });
      unlockBodyOverflow();
      // Restore only when the surface actually closes, using the options that
      // were active while open. Latest options may already have a null restore
      // target (e.g. execution overlay clears mobileExecutionId first).
      if (!activeRef.current) {
        currentOptions?.restoreFocusRef.current?.focus();
      }
    };
  }, [active, dialogRef, legacyInertSelectors, options]);
}
export function trapModalFocus(
  event: KeyboardEvent<HTMLElement>,
  close: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = focusableElements(event.currentTarget);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
