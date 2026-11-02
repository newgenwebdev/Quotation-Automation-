import { auditLog } from "@/db/schema";
import type { Actor } from "@/auth/permissions";

import type { DB } from "@/db/client";

/** Anything that can run an insert: the main DB or a transaction. */
type Writer = Pick<DB, "insert">;

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** Write one row to the append-only audit log. Call inside the same transaction as the change. */
export async function writeAudit(tx: Writer, actor: Actor | "agent:quinn", entry: AuditEntry) {
  await tx.insert(auditLog).values({
    actorId: actor === "agent:quinn" ? null : actor.id,
    actorLabel: actor === "agent:quinn" ? "agent:quinn" : `${actor.role}:${actor.email}`,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: (entry.before ?? null) as object | null,
    after: (entry.after ?? null) as object | null,
    reason: entry.reason ?? null,
  });
}
