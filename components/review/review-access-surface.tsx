"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  useModalSurface,
  useNarrowMode,
} from "@/components/mobile-dialog";

export type ReviewAccessSurfaceKey =
  | "review"
  | "answer"
  | "memory"
  | "delivery";

export type ReviewAccessSurfaceState = {
  kind: "disabled" | "empty" | "error" | "loading" | "ready" | "success";
  message: string;
};

export type ReviewAccessSurfaceProps = {
  initialSurface?: ReviewAccessSurfaceKey;
  sections: Record<ReviewAccessSurfaceKey, ReactNode>;
  states?: Partial<Record<ReviewAccessSurfaceKey, ReviewAccessSurfaceState>>;
  title: string;
};

const surfaces: Array<{
  key: ReviewAccessSurfaceKey;
  label: string;
}> = [
  { key: "review", label: "复核" },
  { key: "answer", label: "回答" },
  { key: "memory", label: "记忆" },
  { key: "delivery", label: "交付" },
];

const readyState: ReviewAccessSurfaceState = {
  kind: "ready",
  message: "可继续操作",
};

function stateId(titleId: string, key: ReviewAccessSurfaceKey): string {
  return `${titleId}-${key}-state`;
}

export function ReviewAccessSurface({
  initialSurface = "review",
  sections,
  states = {},
  title,
}: ReviewAccessSurfaceProps) {
  const narrow = useNarrowMode();
  const [selected, setSelected] = useState<ReviewAccessSurfaceKey>(initialSurface);
  const [modalOpen, setModalOpen] = useState(false);
  const backgroundRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRefs = useRef(new Map<ReviewAccessSurfaceKey, HTMLButtonElement>());
  const restoreFocusRef = useRef<HTMLButtonElement | null>(null);
  const tabRefs = useRef(new Map<ReviewAccessSurfaceKey, HTMLButtonElement>());
  const titleId = `review-access-${title.replace(/\s+/gu, "-")}`;

  const close = useCallback(() => setModalOpen(false), []);
  const modalOptions = useMemo(() => ({
    active: narrow && modalOpen,
    dialogRef,
    hideBackground: true,
    inertRootRefs: [backgroundRef],
    initialFocusRef: closeRef,
    restoreFocusRef,
    onClose: close,
  }), [close, modalOpen, narrow]);
  useModalSurface(modalOptions);

  function selectSurface(key: ReviewAccessSurfaceKey) {
    setSelected(key);
  }

  function openSurface(key: ReviewAccessSurfaceKey) {
    selectSurface(key);
    restoreFocusRef.current = openerRefs.current.get(key) ?? null;
    setModalOpen(true);
  }

  function moveTab(
    event: KeyboardEvent<HTMLButtonElement>,
    key: ReviewAccessSurfaceKey,
  ) {
    const enabledSurfaces = surfaces.filter(
      (surface) => states[surface.key]?.kind !== "disabled",
    );
    const currentIndex = enabledSurfaces.findIndex((surface) => surface.key === key);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % enabledSurfaces.length;
    }
    else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + enabledSurfaces.length) % enabledSurfaces.length;
    } else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = enabledSurfaces.length - 1;
    else return;
    event.preventDefault();
    const next = enabledSurfaces[nextIndex]?.key;
    if (!next) return;
    selectSurface(next);
    tabRefs.current.get(next)?.focus();
  }

  const navigation = (
    <div aria-label={`${title}导航`} className="review-access-tabs" role="tablist">
      {surfaces.map(({ key, label }) => {
        const state = states[key] ?? readyState;
        return (
          <button
            aria-controls={`${titleId}-${key}-panel`}
            aria-describedby={stateId(titleId, key)}
            aria-disabled={state.kind === "disabled" ? "true" : undefined}
            aria-selected={selected === key}
            id={`${titleId}-${key}-tab`}
            key={key}
            onClick={() => {
              if (state.kind !== "disabled") selectSurface(key);
            }}
            onKeyDown={(event) => moveTab(event, key)}
            ref={(node) => {
              if (node) tabRefs.current.set(key, node);
              else tabRefs.current.delete(key);
            }}
            role="tab"
            tabIndex={selected === key ? 0 : -1}
            type="button"
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  const selectedState = states[selected] ?? readyState;
  const panel = (
    <section
      aria-busy={selectedState.kind === "loading" ? "true" : undefined}
      aria-labelledby={`${titleId}-${selected}-tab`}
      className="review-access-panel stack"
      id={`${titleId}-${selected}-panel`}
      role="tabpanel"
    >
      <p className="review-access-state">
        状态：{selectedState.kind}
      </p>
      {selectedState.kind === "error" ? (
        <p className="error-text" role="alert">{selectedState.message}</p>
      ) : selectedState.kind === "success" ? (
        <p aria-live="polite" role="status">{selectedState.message}</p>
      ) : (
        <p>{selectedState.message}</p>
      )}
      {selectedState.kind === "ready" || selectedState.kind === "success"
        ? sections[selected]
        : null}
    </section>
  );

  return (
    <section aria-labelledby={titleId} className="review-access-surface stack">
      <h2 id={titleId}>{title}</h2>
      <div data-testid="review-access-background" ref={backgroundRef}>
        {narrow ? (
          <div aria-label={`${title}入口`} className="review-access-openers">
            {surfaces.map(({ key, label }) => {
              const state = states[key] ?? readyState;
              return (
                <button
                  aria-describedby={stateId(titleId, key)}
                  disabled={state.kind === "disabled"}
                  key={key}
                  onClick={() => openSurface(key)}
                  ref={(node) => {
                    if (node) openerRefs.current.set(key, node);
                    else openerRefs.current.delete(key);
                  }}
                  type="button"
                >
                  打开{label}
                </button>
              );
            })}
          </div>
        ) : (
          <>
            {navigation}
            {panel}
          </>
        )}
        {surfaces.map(({ key }) => (
          <span className="sr-only" id={stateId(titleId, key)} key={key}>
            {(states[key] ?? readyState).message}
          </span>
        ))}
        {surfaces.some(({ key }) => states[key]?.kind === "success") ? (
          <div aria-atomic="true" aria-live="polite" className="sr-only" role="status">
            {surfaces
              .filter(({ key }) => states[key]?.kind === "success")
              .map(({ key }) => states[key]?.message)
              .join("；")}
          </div>
        ) : null}
      </div>
      {narrow && modalOpen ? (
        <div
          aria-label={title}
          aria-modal="true"
          className="modal-surface review-access-dialog"
          ref={dialogRef}
          role="dialog"
        >
          <button
            data-dialog-close="true"
            onClick={close}
            ref={closeRef}
            type="button"
          >
            关闭{title}
          </button>
          {navigation}
          {panel}
        </div>
      ) : null}
    </section>
  );
}
