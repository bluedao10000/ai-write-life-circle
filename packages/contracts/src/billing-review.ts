import { z } from 'zod'
/** UTC account-level review quota. Separate from AI points and creative content. */
export const reviewAllowanceSchema = z.object({
  limit: z.number().int().nonnegative(), used: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(), remaining: z.number().int().nonnegative(),
  resetsAt: z.string().datetime(), unlimited: z.boolean(),
}).strict()
export type ReviewAllowance = z.infer<typeof reviewAllowanceSchema>
