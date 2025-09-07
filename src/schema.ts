
import { z } from "zod";

// RGB configuration for a layer
const RgbConfig = z.object({
  effect: z.string().optional(),
  color: z.array(z.number()).length(3).optional(),
  perKey: z.array(z.object({
    index: z.number(),
    color: z.array(z.number()).length(3)
  })).optional()
}).optional();

// Structured key layout for a layer
const StructuredKeys = z.object({
  left: z.array(z.array(z.string())), // 6 rows with varying lengths
  right: z.array(z.array(z.string())), // 6 rows with varying lengths
  thumb_left: z.array(z.array(z.string()).length(3)).length(2), // 2 rows of 3 keys
  thumb_right: z.array(z.array(z.string()).length(3)).length(2) // 2 rows of 3 keys
});

// Full layout with 80 keys per layer
export const Layout = z.object({
  keyboard: z.literal("glove80"),
  layers: z.array(z.object({
    name: z.string(),
    // Either structured keys OR flat 80-key array for backward compatibility
    keys: StructuredKeys,
    rgb: RgbConfig,
    hrm: z.any().optional()
  })),
  rgbSettings: z.object({
    defaultBrightness: z.number().optional(),
    defaultEffect: z.string().optional()
  }).optional(),
  legends: z.record(z.string()).optional()
});
export type Layout = z.infer<typeof Layout>;

