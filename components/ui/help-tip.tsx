"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Question } from "@phosphor-icons/react";

import { IconButton } from "@/components/ui/icon-button";

type HelpTipProps = {
  children: ReactNode;
  id?: string;
  label: string;
};

export function HelpTip({ children, id, label }: HelpTipProps) {
  const generatedId = useId();
  const panelId = id ?? generatedId;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    setOpen(false);
  }

  return (
    <span className="help-tip" onKeyDown={onKeyDown} ref={rootRef}>
      <IconButton
        aria-controls={panelId}
        aria-expanded={open}
        icon={<Question size={20} weight="regular" />}
        label={label}
        onClick={() => setOpen((current) => !current)}
      />
      <span hidden={!open} id={panelId} role="note">
        {children}
      </span>
    </span>
  );
}
