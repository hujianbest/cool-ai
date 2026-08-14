function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    current += character;
    if (character === "'" && sql[index - 1] !== "\\") {
      if (quoted && sql[index + 1] === "'") {
        current += sql[++index]!;
      } else {
        quoted = !quoted;
      }
    }
    if (character === ";" && !quoted) {
      statements.push(current);
      current = "";
    }
  }
  if (current.trim()) statements.push(current);
  return statements;
}

function splitValues(value: string): string[] {
  const values: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "'" && value[index - 1] !== "\\") {
      if (quoted && value[index + 1] === "'") {
        current += character + value[++index]!;
        continue;
      }
      quoted = !quoted;
    }
    if (!quoted) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (character === "," && depth === 0) {
        values.push(current.trim());
        current = "";
        continue;
      }
    }
    current += character;
  }
  values.push(current.trim());
  return values;
}

function splitTopLevelTuples(sql: string): string[] | null {
  const tuples: string[] = [];
  let index = 0;
  while (index < sql.length) {
    while (index < sql.length && /[\s,]/.test(sql[index]!)) index += 1;
    if (index >= sql.length) break;
    if (sql[index] !== "(") return null;
    let depth = 0;
    let quoted = false;
    const start = index;
    for (; index < sql.length; index += 1) {
      const character = sql[index]!;
      if (character === "'" && sql[index - 1] !== "\\") {
        if (quoted && sql[index + 1] === "'") {
          index += 1;
          continue;
        }
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (character === "(") depth += 1;
      if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          tuples.push(sql.slice(start + 1, index));
          index += 1;
          break;
        }
      }
    }
    if (depth !== 0) return null;
  }
  return tuples;
}

function numberPlaceholders(values: string[], next: { n: number }): string[] {
  return values.map((value) => {
    if (value !== "?") return value;
    next.n += 1;
    return `?${next.n}`;
  });
}

function leaseTokenExpression(id: string): string {
  if (id.startsWith("'") && id.endsWith("'")) {
    return `${id.slice(0, -1)}-lease'`;
  }
  return `(${id} || '-lease')`;
}

function leaseColumnsForRow(columns: string[], values: string[]): string[] {
  const status = values[columns.indexOf("status")] ?? "NULL";
  const assignee = values[columns.indexOf("assignee_agent_id")] ?? "NULL";
  const id = values[columns.indexOf("id")] ?? "'lease'";
  const updated = values[columns.indexOf("updated_at")];
  const created = values[columns.indexOf("created_at")];
  const heartbeat = updated && updated !== "NULL"
    ? updated
    : created && created !== "NULL"
      ? created
      : "'2026-07-30T00:00:00.000Z'";
  const condition = `${status}='in_progress' AND ${assignee} IS NOT NULL`;
  return [
    `CASE WHEN ${condition} THEN ${leaseTokenExpression(id)} ELSE NULL END`,
    `CASE WHEN ${condition} THEN '2099-01-01T00:00:00.000Z' ELSE NULL END`,
    `CASE WHEN ${condition} THEN ${heartbeat} ELSE NULL END`,
  ];
}

function rewriteNamedWorkItemInsert(statement: string): string | null {
  const match = statement.match(
    /^(\s*INSERT\s+INTO\s+work_items\s*\()([\s\S]*?)(\)\s*VALUES\s*)([\s\S]*?)(\s*;?\s*)$/iu,
  );
  if (!match) return null;
  const columns = splitValues(match[2]!);
  if (columns.includes("lease_token")) return statement;
  const rows = splitTopLevelTuples(match[4]!);
  if (!rows || rows.length === 0) return null;
  const next = { n: 0 };
  const numberedRows = rows.map((row) => numberPlaceholders(splitValues(row), next));
  if (numberedRows.some((row) => row.length !== columns.length)) return null;
  const nextColumns = [...columns, "lease_token", "lease_expires_at", "last_heartbeat_at"];
  const nextRows = numberedRows.map((values) => [
    ...values,
    ...leaseColumnsForRow(columns, values),
  ]);
  return `${match[1]}${nextColumns.join(",")}${match[3]}${nextRows.map((row) => `(${row.join(",")})`).join(",")}${match[5]}`;
}

function rewritePositionalWorkItemInsert(statement: string): string {
  const match = statement.match(
    /^(\s*INSERT\s+INTO\s+work_items\s+VALUES\s*\()([\s\S]*)(\)\s*;?\s*)$/iu,
  );
  if (!match) return statement;
  const values = splitValues(match[2]!);
  if (values.length !== 9) return statement;
  const columns = [
    "id",
    "mission_id",
    "title",
    "description",
    "status",
    "assignee_agent_id",
    "version",
    "created_at",
    "updated_at",
  ];
  return `${match[1]}${[...values, ...leaseColumnsForRow(columns, values)].join(",")}${match[3]}`;
}

export function rewriteWorkItemLease(statement: string): string {
  if (!/\bINSERT\s+INTO\s+work_items\b/iu.test(statement)) return statement;
  return rewriteNamedWorkItemInsert(statement) ?? rewritePositionalWorkItemInsert(statement);
}

export function rewriteWorkItemLeaseSql(sql: string): string {
  return splitStatements(sql).map(rewriteWorkItemLease).join("");
}
