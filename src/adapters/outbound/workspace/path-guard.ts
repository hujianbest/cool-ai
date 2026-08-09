import { PathGuardError } from "@/src/modules/safe-execution";

export { PathGuardError } from "@/src/modules/safe-execution";

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function invalid(message: string): never {
  throw new PathGuardError(message);
}

export function validateSandboxRelativePath(input: string): {
  path: string;
  segments: string[];
} {
  if (typeof input !== "string" || input.length === 0) {
    return invalid("Sandbox paths must be non-empty strings.");
  }
  if (
    input.includes("\\")
    || input.startsWith("/")
    || input.startsWith("//")
    || /^[a-z]:/iu.test(input)
    || input.includes(":")
    || CONTROL_CHARACTER.test(input)
  ) {
    return invalid("Sandbox paths cannot use absolute, device, stream, or control syntax.");
  }

  const rawSegments = input.split("/");
  if (
    rawSegments.some((segment) =>
      segment.length === 0 || segment === "." || segment === "..")
  ) {
    return invalid("Sandbox paths cannot contain empty, dot, or parent segments.");
  }

  const segments = rawSegments.map((segment) => segment.normalize("NFC"));
  for (const segment of segments) {
    const bytes = Buffer.byteLength(segment, "utf8");
    const windowsComparable = segment.replace(/[ .]+$/u, "");
    if (
      bytes < 1
      || bytes > 255
      || /[ .]$/u.test(segment)
      || windowsComparable.length === 0
      || WINDOWS_RESERVED_NAME.test(windowsComparable)
      || CONTROL_CHARACTER.test(segment)
    ) {
      return invalid("A sandbox path segment is invalid or reserved.");
    }
  }

  const path = segments.join("/");
  if (Buffer.byteLength(path, "utf8") > 4096) {
    return invalid("Sandbox paths cannot exceed 4096 UTF-8 bytes.");
  }
  return { path, segments };
}
