import { z } from "zod";
import * as s from "../../contracts/schemas.js";

export const billingStatus = z.enum(["ACTIVE", "PAST_DUE", "SUSPENDED", "CLOSED"]);
export const rawBillingProfile = z.object({
  id: s.id,
  organizationId: s.id,
  status: billingStatus,
  currency: z.literal("USD"),
  basePriceMinor: z.literal(1400),
  memberPriceMinor: z.literal(500),
  billingEmail: z.string().email().nullable(),
  createdAt: s.date,
  updatedAt: s.date,
});
export const billingView = rawBillingProfile.extend({
  billableMemberCount: z.number().int().nonnegative(),
  groupsCostMinor: z.literal(0),
  estimatedMonthlyMinor: z.number().int().nonnegative(),
});
