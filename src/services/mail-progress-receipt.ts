import { z } from "zod";

// Lictor wraps the whole Cc chat response in its own message field.
const ReceiptSchema = z.object({
  ok: z.literal(true),
  relayed: z.literal(1),
  message: z.object({ message: z.object({ id: z.number().int().positive().safe() }) }),
});

/** @implements SPEC-MAIL-CRAWLER-006 */
export function acceptedProgressMessageId(receipt: unknown): number | null {
  const parsed = ReceiptSchema.safeParse(receipt);
  return parsed.success ? parsed.data.message.message.id : null;
}
