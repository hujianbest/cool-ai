import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { MemoryError, type KnowledgeGraphDto } from "@/src/modules/knowledge-provenance";

type MemoryGraphRow = {
  content: string;
  id: string;
  supersedesId: string | null;
};

type CollectionMemberRow = {
  collectionId: string;
  memoryId: string | null;
};

export function getKnowledgeGraph(
  databasePath: string,
  projectId: string,
): KnowledgeGraphDto {
  const database = openDatabase(databasePath);
  try {
    if (database.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId) === undefined) {
      throw new MemoryError("PROJECT_NOT_FOUND", 404, "Project was not found.");
    }
    const rows = database.prepare(`
      SELECT id, content, supersedes_id AS supersedesId
      FROM memory_entries
      WHERE project_id=?
      ORDER BY created_at, id
    `).all(projectId) as unknown as MemoryGraphRow[];
    const memberRows = database.prepare(`
      SELECT
        member.collection_id AS collectionId,
        (
          SELECT entry.id FROM memory_entries entry
          WHERE entry.project_id=member.project_id
            AND entry.chain_id=member.chain_id
            AND NOT EXISTS (
              SELECT 1 FROM memory_entries child WHERE child.supersedes_id = entry.id
            )
        ) AS memoryId
      FROM memory_collection_members member
      WHERE member.project_id=?
      ORDER BY member.collection_id, member.chain_id
    `).all(projectId) as unknown as CollectionMemberRow[];
    const membersByCollection = new Map<string, string[]>();
    for (const member of memberRows) {
      if (member.memoryId === null) continue;
      const current = membersByCollection.get(member.collectionId) ?? [];
      current.push(member.memoryId);
      membersByCollection.set(member.collectionId, current);
    }
    const collectionEdges: KnowledgeGraphDto["edges"] = [];
    const seen = new Set<string>();
    for (const members of membersByCollection.values()) {
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          const left = members[i];
          const right = members[j];
          if (left === undefined || right === undefined) continue;
          const [fromId, toId] = left < right ? [left, right] : [right, left];
          const key = `${fromId}:${toId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          collectionEdges.push({ fromId, kind: "collection", toId });
        }
      }
    }
    return {
      edges: [
        ...rows.flatMap((row) => (
          row.supersedesId === null
            ? []
            : [{ fromId: row.id, kind: "supersedes" as const, toId: row.supersedesId }]
        )),
        ...collectionEdges,
      ],
      nodes: rows.map((row) => ({ id: row.id, title: row.content })),
    };
  } finally {
    database.close();
  }
}
