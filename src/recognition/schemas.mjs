import { z } from "zod";

const dateString = z.string().refine(
  value => value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value),
  "日期必须为空字符串或 YYYY-MM-DD",
);
const amount = z.number().finite().nonnegative("金额必须大于等于 0").nullable();
// Discount rows may be negative; summary amounts still use the nonnegative schema.
const lineAmount = z.number().finite().nullable();

export const classifierSchema = z.object({
  document_type: z.enum(["order", "invoice", "unknown"]),
}).strict();

export const orderSchema = z.object({
  product: z.string(),
  price: amount,
  expense_date: dateString,
  payment_method: z.string(),
}).strict();

export const invoiceItemSchema = z.object({
  name: z.string(),
  amount: lineAmount,
}).strict();

export const invoiceSchema = z.object({
  invoice_number: z.string(),
  invoice_date: dateString,
  buyer_name: z.string(),
  buyer_tax_id: z.string(),
  seller_name: z.string(),
  seller_tax_id: z.string(),
  amount_without_tax: amount,
  tax_amount: amount,
  total_amount: amount,
  // Item details are auxiliary; unavailable or malformed details must not block totals and tax IDs.
  items: z.array(invoiceItemSchema).catch([]),
}).strict();
