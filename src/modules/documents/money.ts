import { Prisma } from "../../lib/database.js";
import { fail } from "../../shared/errors.js";

/**
 * Exact decimal arithmetic. Amounts travel as strings in the API and are never
 * floating point. Rounding is half-up to cents, applied per line.
 */
const Decimal = Prisma.Decimal;
export type Money = Prisma.Decimal;

const QUANTITY = /^\d{1,4}(\.\d{1,3})?$/;
const PRICE = /^\d{1,7}(\.\d{1,2})?$/;
const MAX_LINE = new Decimal("9999999999.99");
const MAX_TOTAL = new Decimal("999999999999.99");

export function parseQuantity(value: string): Money {
  if (!QUANTITY.test(value)) fail(422, "DOCUMENT_ITEM_INVALID", "Quantity must be a positive number with up to 3 decimals");
  const quantity = new Decimal(value);
  if (quantity.lte(0)) fail(422, "DOCUMENT_ITEM_INVALID", "Quantity must be greater than zero");
  return quantity;
}

export function parseUnitPrice(value: string): Money {
  if (!PRICE.test(value)) fail(422, "DOCUMENT_ITEM_INVALID", "Price must be a non-negative amount with up to 2 decimals");
  return new Decimal(value);
}

export function lineTotal(quantity: Money, unitPrice: Money): Money {
  const total = quantity.mul(unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (total.gt(MAX_LINE)) fail(422, "DOCUMENT_TOTAL_TOO_LARGE", "A line total exceeds the supported maximum");
  return total;
}

export type ComputedLine = { quantity: Money; unitPrice: Money; total: Money };

/** Discounts and taxes are reserved columns (always zero for now): total = subtotal - discount + tax. */
export function computeTotals(lines: Array<{ total: Money }>) {
  const subtotal = lines.reduce((sum, line) => sum.plus(line.total), new Decimal(0));
  const discountTotal = new Decimal(0);
  const taxTotal = new Decimal(0);
  const total = subtotal.minus(discountTotal).plus(taxTotal);
  if (total.gt(MAX_TOTAL)) fail(422, "DOCUMENT_TOTAL_TOO_LARGE", "The document total exceeds the supported maximum");
  return { subtotal, discountTotal, taxTotal, total };
}

/** Canonical API representation: fixed decimals, no exponent. */
export const money = (value: Money) => value.toFixed(2);
export const quantityText = (value: Money) => value.toFixed(3).replace(/\.?0+$/, "") || "0";

export function formatMoney(value: string, currency: string) {
  const [whole = "0", fraction = "00"] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency === "USD" ? "$" : `${currency} `}${grouped}.${fraction.padEnd(2, "0")}`;
}
