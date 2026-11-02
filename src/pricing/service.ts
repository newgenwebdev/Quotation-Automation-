/**
 * Pricing service: loads approved data from the database, then hands it to the
 * pure pricing engine. Later phases (Quinn's drafts) call this — never the AI.
 */
import type { DB } from "@/db/client";
import { assertCan, type Actor } from "@/auth/permissions";
import { loadActivePolicy, loadCatalogueForPricing } from "@/catalogue/service";
import { calculatePrice, type PricingInput, type PricingResult } from "./engine";

export async function priceQuotation(
  db: DB, actor: Actor, input: Omit<PricingInput, "requestedByRole">,
): Promise<PricingResult> {
  assertCan(actor, "pricing.calculate");
  const codes = [...new Set(input.lines.map((l) => l.catalogueCode))];
  const [catalogue, policy] = await Promise.all([loadCatalogueForPricing(db, codes), loadActivePolicy(db)]);
  // The role comes from the logged-in user, never from the request body,
  // so nobody can claim to be Finance to sneak a discount through.
  return calculatePrice({ ...input, requestedByRole: actor.role }, { catalogue, policy });
}
