"use client";

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

type IconButtonProps = {
  icon: ReactNode;
  label: string;
  ref?: Ref<HTMLButtonElement>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children">;

export function IconButton({
  className,
  icon,
  label,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      {...props}
      aria-label={label}
      className={["icon-button", className].filter(Boolean).join(" ")}
      type={type}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}
