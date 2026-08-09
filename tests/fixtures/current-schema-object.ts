import { CURRENT_SCHEMA } from "@/src/adapters/outbound/sqlite/current-schema";

export function currentSchemaObjectSql(name: string): string {
  const object = CURRENT_SCHEMA.objects.find((candidate) => candidate.name === name);
  if (!object) throw new Error(`Current schema object ${name} is unavailable.`);
  return object.createSql;
}
