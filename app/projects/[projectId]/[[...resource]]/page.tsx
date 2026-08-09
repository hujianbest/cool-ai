import { join } from "node:path";

import { ProjectPanel } from "@/components/project-panel";
import {
  parseProjectSelection,
  reconcileReturnTo,
} from "@/components/settings-navigation";
import { readThreadDetail } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";

type SourceReferencePageProps = {
  params: Promise<{
    projectId: string;
    resource?: string[];
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

async function projectReturnTo(
  projectId: string,
  query: Record<string, string | string[] | undefined>,
) {
  const project = parseProjectSelection(
    `/projects/${encodeURIComponent(projectId)}`,
  );
  if (!project) return "/" as const;
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) searchParams.append(key, item);
    } else if (value !== undefined) {
      searchParams.append(key, value);
    }
  }
  const candidate = searchParams.size > 0
    ? `${project.projectHref}?${searchParams.toString()}`
    : project.projectHref;
  return reconcileReturnTo(candidate, (selectedProjectId, threadId, runId) => {
    readThreadDetail(
      databasePath(),
      selectedProjectId,
      threadId,
      runId,
    );
    return true;
  });
}

// 可追溯来源引用页面组件（当 resource 非空时渲染）
function SourceReferencePage({
  projectId,
  resourcePath,
  version,
}: {
  projectId: string;
  resourcePath: string;
  version: string | null;
}) {
  return (
    <main
      aria-labelledby="source-reference-title"
      className="stack"
      id="source-reference"
    >
      <p className="eyebrow">可追溯来源</p>
      <h1 id="source-reference-title">版本化来源引用</h1>
      <dl>
        <div>
          <dt>项目</dt>
          <dd><code>{projectId}</code></dd>
        </div>
        <div>
          <dt>资源</dt>
          <dd><code>{resourcePath || "项目"}</code></dd>
        </div>
        <div>
          <dt>version</dt>
          <dd><code>{version ?? "未指定"}</code></dd>
        </div>
      </dl>
      <p>
        此目标保留共享记忆记录的精确来源路径与版本，不把来源链接伪装成操作成功。
      </p>
      <a href="/">返回协作驾驶舱</a>
    </main>
  );
}

export default async function SourceReferencePageRoute({
  params,
  searchParams,
}: SourceReferencePageProps) {
  const { projectId, resource = [] } = await params;
  const query = await searchParams;
  const version = Array.isArray(query.version)
    ? query.version[0]
    : query.version;
  const resourcePath = resource.join("/");

  // 当 resource 为空时，渲染 ProjectPanel（项目路由化）
  // 当 resource 非空时，渲染来源引用页面（向后兼容）
  if (resource.length === 0) {
    return <ProjectPanel returnTo={await projectReturnTo(projectId, query)} />;
  }

  return (
    <SourceReferencePage
      projectId={projectId}
      resourcePath={resourcePath}
      version={version ?? null}
    />
  );
}
