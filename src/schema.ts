
import { z } from "zod";

export const Layout = z.object({
  keyboard: z.literal("glove80"),
  layers: z.array(z.object({
    name: z.string(),
    rows: z.array(z.array(z.string())),
    hrm: z.any().optional()
  })),
  legends: z.record(z.string()).optional()
});
export type Layout = z.infer<typeof Layout>;

