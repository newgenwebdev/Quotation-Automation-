/**
 * WHO MAY DO WHAT
 * One central list, so permissions are never scattered or forgotten.
 * Every service checks here before acting.
 */
import type { Role } from "@/db/schema";

export const PERMISSIONS = {
  "catalogue.read": ["sales", "technical", "finance", "admin"],
  "catalogue.draft": ["finance", "admin"],
  "catalogue.approve": ["finance", "admin"],
  "catalogue.retire": ["finance", "admin"],
  "policy.draft": ["finance", "admin"],
  "policy.approve": ["finance", "admin"],
  "pricing.calculate": ["sales", "technical", "finance", "admin"],
  "pricing.applyDiscount": ["finance", "admin"],
  "catalogue.viewDrafts": ["finance", "admin"],
  "audit.read": ["finance", "admin"],
  "users.manage": ["admin"],
  "quotes.create": ["sales", "finance", "admin"],
  /** Sales see only their own quotations; these roles see everyone's. */
  "quotes.viewAll": ["technical", "finance", "admin"],
  "quotes.approve": ["finance", "admin"],
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
