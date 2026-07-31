import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type VerifiedSandboxManifestEntry = {
  identity: string;
  modeTag: string;
  path: string;
  sha256: string;
  size: number;
};

export type VerifiedSandboxManifest = {
  entries: VerifiedSandboxManifestEntry[];
  hash: string;
  stagingEntries?: Array<{
    content?: string;
    identity?: string;
    kind: "binary" | "link" | "special" | "text";
    modeTag: string;
    path: string;
    sha256: string;
    size: number;
  }>;
};

export async function persistVerifiedSandboxManifest(
  sandboxRoot: string,
  manifest: VerifiedSandboxManifest,
): Promise<string> {
  const directory = dirname(sandboxRoot);
  const path = join(directory, `sandbox-manifest-${randomUUID()}.json`);
  const temporary = `${path}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, JSON.stringify({
    entries: manifest.entries,
    hash: manifest.hash,
  }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  return path;
}
