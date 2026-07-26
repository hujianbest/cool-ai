export const PROVIDERS = [
  { id: "zhipuai-coding-plan", label: "GLM (zhipuai-coding-plan)" },
] as const;

export const TOOLS = [
  { id: "file.read", label: "文件读取" },
  { id: "file.write", label: "文件写入" },
  { id: "shell", label: "Shell 执行" },
  { id: "web.search", label: "网络搜索" },
] as const;
