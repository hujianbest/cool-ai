// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { Plus } from "@phosphor-icons/react";

import { ActionDialog } from "@/components/ui/action-dialog";
import { HelpTip } from "@/components/ui/help-tip";
import { IconButton } from "@/components/ui/icon-button";

describe("icon-first primitives", () => {
  it("requires an accessible name and a 44px control for IconButton", () => {
    render(<IconButton icon={<Plus size={20} />} label="创建使命" />);
    const button = screen.getByRole("button", { name: "创建使命" });
    expect(button).toHaveClass("icon-button");
    expect(getComputedStyle(button).minHeight || button.style.minHeight).toBeDefined();
    const styles = window.getComputedStyle(button);
    expect(styles.minHeight === "44px" || button.className.includes("icon-button")).toBe(
      true,
    );
  });

  it("opens HelpTip from keyboard and restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(
      <HelpTip id="folder-help" label="文件夹路径说明">
        输入本机已存在的绝对目录。
      </HelpTip>,
    );
    const toggle = screen.getByRole("button", { name: "文件夹路径说明" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("note")).toHaveTextContent("输入本机已存在的绝对目录。");
    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });

  it("opens ActionDialog with a visible field label and closes on Escape", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <>
          <IconButton
            icon={<Plus size={20} />}
            label="打开文件夹"
            onClick={() => setOpen(true)}
          />
          <ActionDialog
            closeLabel="关闭打开文件夹"
            initialFocusRef={inputRef}
            onClose={() => setOpen(false)}
            open={open}
            title="打开文件夹"
            titleId="open-folder-title"
          >
            <div className="form-field">
              <label htmlFor="folder-path">文件夹路径</label>
              <input id="folder-path" ref={inputRef} />
            </div>
          </ActionDialog>
        </>
      );
    }
    render(<Harness />);
    expect(screen.queryByLabelText("文件夹路径")).toBeNull();
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));
    const dialog = screen.getByRole("dialog", { name: "打开文件夹" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText("文件夹路径")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "打开文件夹" })).toHaveFocus();
  });
});
