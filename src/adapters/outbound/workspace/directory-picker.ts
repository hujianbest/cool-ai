import { spawn } from "node:child_process";

export type DirectoryPickResult =
  | { kind: "picked"; path: string }
  | { kind: "cancelled" };

export class DirectoryPickerError extends Error {
  readonly code = "PICKER_UNAVAILABLE";
  constructor() {
    super("无法打开系统文件夹选择器");
    this.name = "DirectoryPickerError";
  }
}

type SpawnOutcome = {
  spawnFailed: boolean;
  stdout: string;
  exitCode: number | null;
};

const WINDOWS_FOLDER_DIALOG = [
  "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = '选择项目文件夹'",
  "try { $dialog.UseDescriptionForTitle = $true } catch {}",
  "$dialog.ShowNewFolderButton = $true",
  "[System.Windows.Forms.Application]::EnableVisualStyles()",
  "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
  "  [Console]::Out.Write($dialog.SelectedPath)",
  "}",
].join("; ");

function allowsScriptedPicker(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.COCKPIT_ALLOW_SCRIPTED_PICKER === "1"
  );
}

function scriptedDirectory(): string | undefined {
  if (!allowsScriptedPicker()) return undefined;
  const value = process.env.COCKPIT_SCRIPTED_DIRECTORY;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasGraphicalSession(): boolean {
  return Boolean(
    process.env.DISPLAY?.trim() || process.env.WAYLAND_DISPLAY?.trim(),
  );
}

function run(command: string, args: string[]): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", () => {
      resolve({ spawnFailed: true, stdout: "", exitCode: null });
    });
    child.on("close", (code) => {
      resolve({
        spawnFailed: false,
        stdout: Buffer.concat(chunks).toString("utf8"),
        exitCode: code,
      });
    });
  });
}

function toResult(stdout: string): DirectoryPickResult {
  const path = stdout.replace(/^\uFEFF/, "").trim();
  if (!path) return { kind: "cancelled" };
  return { kind: "picked", path };
}

function linuxOutcome(outcome: SpawnOutcome): DirectoryPickResult | "next" {
  if (outcome.spawnFailed) return "next";
  if (outcome.exitCode === 0) return toResult(outcome.stdout);
  if (hasGraphicalSession()) return { kind: "cancelled" };
  return "next";
}

export async function pickDirectory(): Promise<DirectoryPickResult> {
  const scripted = scriptedDirectory();
  if (scripted) return { kind: "picked", path: scripted };

  if (process.platform === "win32") {
    const outcome = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-Command",
      WINDOWS_FOLDER_DIALOG,
    ]);
    if (outcome.spawnFailed) throw new DirectoryPickerError();
    return toResult(outcome.stdout);
  }

  if (process.platform === "darwin") {
    const outcome = await run("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "选择项目文件夹")',
    ]);
    if (outcome.spawnFailed) throw new DirectoryPickerError();
    return toResult(outcome.stdout);
  }

  const zenity = await run("zenity", [
    "--file-selection",
    "--directory",
    "--title=选择项目文件夹",
  ]);
  const zenityResult = linuxOutcome(zenity);
  if (zenityResult !== "next") return zenityResult;

  const kdialog = await run("kdialog", [
    "--getexistingdirectory",
    ".",
    "选择项目文件夹",
  ]);
  const kdialogResult = linuxOutcome(kdialog);
  if (kdialogResult !== "next") return kdialogResult;

  throw new DirectoryPickerError();
}
