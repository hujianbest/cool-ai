import { z } from "zod";

/**
 * Thread search wire contracts (feature 031 T-02, CAP-OPS-02). Shared between
 * the operations-projection module, the inbound thread-search route, and the
 * thread search UI (T-03), mirroring the audit-contracts sinking precedent
 * (A-145). Self-contained: src/shared must not depend on any upper layer.
 */
export const threadSearchResultKindSchema = z.enum(["thread_title", "message"]);

export const threadSearchResultItemSchema = z.object({
  kind: threadSearchResultKindSchema,
  /** Null on thread-title hits. */
  messageId: z.string().min(1).nullable(),
  occurredAt: z.string().min(1),
  /**
   * Title hits carry the full title; message hits carry a ±60-grapheme window
   * around the first match with … ellipses where truncated.
   */
  snippet: z.string().min(1),
  threadId: z.string().min(1),
  threadTitle: z.string().min(1),
}).strict();

export const projectThreadSearchPageSchema = z.object({
  /** Opaque exclusive cursor for the next (older) page; null when no more hits. */
  nextCursor: z.string().min(1).nullable(),
  results: z.array(threadSearchResultItemSchema),
}).strict();

export type ProjectThreadSearchPageDto = z.infer<typeof projectThreadSearchPageSchema>;
export type ThreadSearchResultItemDto = z.infer<typeof threadSearchResultItemSchema>;
export type ThreadSearchResultKind = z.infer<typeof threadSearchResultKindSchema>;
