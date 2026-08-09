import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";

export const ROOT = process.cwd();

const SKIP_DIRS = new Set(["node_modules", ".next", "__pycache__"]);

export function sourceFiles(relativeDirectory: string): string[] {
  const directory = resolve(ROOT, relativeDirectory);
  let entries;
  try {
    entries = readdirSync(directory, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name))
    .map((entry) => relative(ROOT, resolve(entry.parentPath, entry.name)))
    .filter((path) => ![...path.split("/")].some((part) => SKIP_DIRS.has(part)))
    .sort();
}

export function readSource(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

const IMPORT_RE = /(?:^|\s)import\s+(?:type\s+)?(?:[^"']*\sfrom\s+)?["']([^"']+)["']/gu;
const EXPORT_FROM_RE = /(?:^|\s)export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/gu;
const REQUIRE_RE = /require\(["']([^"']+)["']\)/gu;

export type ImportEdge = { specifier: string; typeOnly: boolean };

export function importEdges(relativePath: string): ImportEdge[] {
  const text = readSource(relativePath);
  const edges: ImportEdge[] = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    edges.push({ specifier: match[1], typeOnly: /import\s+type/u.test(match[0]) });
  }
  for (const match of text.matchAll(EXPORT_FROM_RE)) {
    edges.push({ specifier: match[1], typeOnly: /export\s+type/u.test(match[0]) });
  }
  for (const match of text.matchAll(REQUIRE_RE)) {
    edges.push({ specifier: match[1], typeOnly: false });
  }
  return edges;
}

/** Resolve an import specifier to a repo-relative path prefix (best effort, alias-aware). */
export function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith("@/")) {
    return specifier.slice(2);
  }
  if (specifier.startsWith(".")) {
    const base = fromFile.split("/").slice(0, -1);
    for (const part of specifier.split("/")) {
      if (part === ".") continue;
      else if (part === "..") base.pop();
      else base.push(part);
    }
    return base.join("/");
  }
  return null; // external package or node: builtin
}
