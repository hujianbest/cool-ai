import { getMissionState } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { MissionError } from "@/src/modules/mission-work";
import type {
  SopMatchedWorkItem,
  SopStateItem,
  SopStateProjection,
} from "@/src/modules/mission-work";
import { WorkspaceError, type ProjectWorkspaceQueries } from "@/src/modules/project-workspace";
import type { WorkItem } from "@/src/shared/project-context-contracts";

const FEATURES_DIR = "features";
const PROGRESS_FILE = "progress.md";
const MAX_ITEMS = 20;
const TITLE_PREFIX = "- 特性:";
const STAGE_PREFIX = "- 当前阶段:";

export type SopWorkspaceBrowse = Pick<
  ProjectWorkspaceQueries,
  "listWorkspaceDirectory" | "readWorkspaceFilePreview"
>;

function byRelativePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byWorkItemId(left: SopMatchedWorkItem, right: SopMatchedWorkItem): number {
  return left.workItemId < right.workItemId ? -1 : left.workItemId > right.workItemId ? 1 : 0;
}

function emptyProjection(workspaceBound: boolean): SopStateProjection {
  return {
    workspaceBound,
    readAt: new Date().toISOString(),
    items: [],
  };
}

function parseProgressLines(text: string): { declaredStage: string; featureTitle: string } {
  let declaredStage = "";
  let featureTitle = "";
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith(STAGE_PREFIX)) {
      declaredStage = line.slice(STAGE_PREFIX.length).trim();
    } else if (line.startsWith(TITLE_PREFIX)) {
      featureTitle = line.slice(TITLE_PREFIX.length).trim();
    }
  }
  return { declaredStage, featureTitle };
}

function matchingWorkItems(
  workItems: WorkItem[],
  slug: string,
  featureTitle: string,
): SopMatchedWorkItem[] {
  const matched: SopMatchedWorkItem[] = [];
  for (const workItem of workItems) {
    const matchesSlug = workItem.title.includes(slug);
    const matchesTitle = featureTitle.length > 0 && workItem.title.includes(featureTitle);
    if (!matchesSlug && !matchesTitle) continue;
    matched.push({
      workItemId: workItem.id,
      title: workItem.title,
      status: workItem.status,
    });
  }
  matched.sort(byWorkItemId);
  return matched;
}

export function deriveSopItemFreshness(
  declaredStage: string,
  matches: SopMatchedWorkItem[],
  unreadable: boolean,
): Pick<SopStateItem, "freshness" | "staleReason"> {
  if (unreadable) {
    return { freshness: "stale", staleReason: "source_unreadable" };
  }
  if (matches.length === 0) {
    return { freshness: "current", staleReason: null };
  }
  const allDone = matches.every((entry) => entry.status === "done");
  const someOpen = matches.some((entry) => entry.status !== "done");
  if ((declaredStage === "done" && someOpen) || (declaredStage !== "done" && allDone)) {
    return { freshness: "stale", staleReason: "declared_stage_diverges" };
  }
  return { freshness: "current", staleReason: null };
}

function relativeProgressPath(slug: string): string {
  return `${FEATURES_DIR}/${slug}/${PROGRESS_FILE}`;
}

async function readFeatureItem(
  databasePath: string,
  projectId: string,
  slug: string,
  workItems: WorkItem[],
  browse: SopWorkspaceBrowse,
): Promise<SopStateItem | null> {
  const relativePath = relativeProgressPath(slug);
  let preview;
  try {
    preview = await browse.readWorkspaceFilePreview(databasePath, projectId, relativePath);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "WORKSPACE_ENTRY_NOT_FOUND") {
      return null;
    }
    if (error instanceof WorkspaceError) {
      const matches = matchingWorkItems(workItems, slug, "");
      return {
        relativePath,
        title: slug,
        declaredStage: "",
        ...deriveSopItemFreshness("", matches, true),
        workItems: matches,
      };
    }
    throw error;
  }

  if (preview.kind !== "text") {
    const matches = matchingWorkItems(workItems, slug, "");
    return {
      relativePath,
      title: slug,
      declaredStage: "",
      ...deriveSopItemFreshness("", matches, true),
      workItems: matches,
    };
  }

  const parsed = parseProgressLines(preview.content);
  const title = parsed.featureTitle.length > 0 ? parsed.featureTitle : slug;
  const matches = matchingWorkItems(workItems, slug, parsed.featureTitle);
  return {
    relativePath,
    title,
    declaredStage: parsed.declaredStage,
    ...deriveSopItemFreshness(parsed.declaredStage, matches, false),
    workItems: matches,
  };
}

export async function getSopStateProjection(
  databasePath: string,
  projectId: string,
  browse: SopWorkspaceBrowse,
): Promise<SopStateProjection> {
  const missionState = getMissionState(databasePath, projectId);
  let listing;
  try {
    listing = await browse.listWorkspaceDirectory(databasePath, projectId, FEATURES_DIR);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "WORKSPACE_NOT_BOUND") {
      return emptyProjection(false);
    }
    if (error instanceof WorkspaceError && error.code === "WORKSPACE_ENTRY_NOT_FOUND") {
      return emptyProjection(true);
    }
    if (error instanceof WorkspaceError && error.code === "PROJECT_NOT_FOUND") {
      throw new MissionError("PROJECT_NOT_FOUND", 404, "Project was not found.");
    }
    throw error;
  }

  const candidatePaths = listing.entries
    .filter((entry) => entry.kind === "dir")
    .map((entry) => ({ slug: entry.name, relativePath: relativeProgressPath(entry.name) }))
    .sort((left, right) => byRelativePath(left.relativePath, right.relativePath));

  const items: SopStateItem[] = [];
  for (const candidate of candidatePaths) {
    if (items.length >= MAX_ITEMS) break;
    const item = await readFeatureItem(
      databasePath,
      projectId,
      candidate.slug,
      missionState.workItems,
      browse,
    );
    if (item) items.push(item);
  }

  return {
    workspaceBound: true,
    readAt: new Date().toISOString(),
    items,
  };
}
