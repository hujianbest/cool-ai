type SourceReferencePageProps = {
  params: Promise<{
    projectId: string;
    resource?: string[];
  }>;
  searchParams: Promise<{
    version?: string | string[];
  }>;
};

export default async function SourceReferencePage({
  params,
  searchParams,
}: SourceReferencePageProps) {
  const { projectId, resource = [] } = await params;
  const query = await searchParams;
  const version = Array.isArray(query.version)
    ? query.version[0]
    : query.version;
  const resourcePath = resource.join("/");

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
