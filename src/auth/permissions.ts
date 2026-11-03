/**
 * WHO MAY DO WHAT
 * One central list, so permissions are never scattered or forgotten. Every service checks here.
 *
 * For now there is a single role, Admin: every signed-in team member can create, edit,
 * finalise and export quotations and manage Settings. (The old Sales / Technical / Finance
 * values remain in the database type only for history; migration 0009 moved everyone to Admin.)
 * To bring roles back later, add them to the lists below.
 */
import type { Role } from "@/db/schema";

export const PERMISSIONS = {
  "quotes.create": ["admin"],
  /** See everyone's quotations (not just your own). */
  "quotes.viewAll": ["admin"],
  "catalogue.read": ["admin"],
  "catalogue.manage": ["admin"],
  "policy.manage": ["admin"],
  "terms.manage": ["admin"],
  "company.manage": ["admin"],
  "users.manage": ["admin"],
  "audit.read": ["admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export interface Actor {
  id: string;
  role: Role;
  email: string;
}

export class PermissionError extends Error {
  readonly code = "FORBIDDEN";
  constructor(public permission: Permission, public role: Role) {
    super(`Role "${role}" is not allowed to perform "${permission}"`);
  }
}

export function can(actor: Actor, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(actor.role);
}

export function assertCan(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) throw new PermissionError(permission, actor.role);
}
