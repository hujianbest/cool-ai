"use client";

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";

import { trapModalFocus, useModalSurface } from "@/components/mobile-dialog";
import { IconButton } from "@/components/ui/icon-button";

type ActionDialogProps = {
  children: ReactNode;
  closeLabel: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  open: boolean;
  title: string;
  titleId: string;
};

export function ActionDialog({
  children,
  closeLabel,
  initialFocusRef,
  onClose,
  open,
  title,
  titleId,
}: ActionDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  restoreFocusRef.current = restoreRef.current;
  const [inertRoots, setInertRoots] = useState<HTMLElement[]>([]);

  useLayoutEffect(() => {
    if (!open) {
      setInertRoots([]);
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement) restoreRef.current = active;
    setInertRoots(
      Array.from(document.body.children).filter(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node !== hostRef.current,
      ),
    );
  }, [open]);

  const inertRootRefs = useMemo(
    () => inertRoots.map((node) => ({ current: node })),
    [inertRoots],
  );

  const options = useMemo(
    () => ({
      active: open,
      dialogRef,
      hideBackground: true as const,
      inertRootRefs,
      initialFocusRef: initialFocusRef ?? closeRef,
      onClose,
      restoreFocusRef,
    }),
    [inertRootRefs, initialFocusRef, onClose, open],
  );
  useModalSurface(options);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="action-dialog-root"
      data-action-dialog-root=""
      ref={hostRef}
    >
      <div aria-hidden="true" className="action-dialog-scrim" />
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="action-dialog stack"
        onKeyDown={(event) => trapModalFocus(event, onClose)}
        ref={dialogRef}
        role="dialog"
      >
        <header className="action-dialog-header">
          <h2 id={titleId}>{title}</h2>
          <IconButton
            className="button-ghost"
            data-dialog-close="true"
            icon={<X size={20} weight="regular" />}
            label={closeLabel}
            onClick={onClose}
            ref={closeRef}
          />
        </header>
        {children}
      </section>
    </div>,
    document.body,
  );
}
