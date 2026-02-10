
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
  left: z.array(z.array(z.string())).length(6), // 6 rows with varying lengths
  right: z.array(z.array(z.string())).length(6), // 6 rows with varying lengths
  thumb_left: z.array(z.array(z.string()).length(3)).length(2), // 2 rows of 3 keys
  thumb_right: z.array(z.array(z.string()).length(3)).length(2) // 2 rows of 3 keys
});

// Structured LED layout for a layer (same structure as keys)
const StructuredLED = z.object({
  left: z.array(z.array(z.string())).length(6), // 6 rows with color names
  right: z.array(z.array(z.string())).length(6), // 6 rows with color names
  thumb_left: z.array(z.array(z.string()).length(3)).length(2), // 2 rows of 3 colors
  thumb_right: z.array(z.array(z.string()).length(3)).length(2) // 2 rows of 3 colors
}).optional();

// Full layout with 80 keys per layer
export const Layout = z.object({
  keyboard: z.literal("glove80"),
  colorDefinitions: z.record(z.array(z.number()).length(3)).optional(), // Color name -> [R, G, B]
  layers: z.array(z.object({
    name: z.string(),
    keys: StructuredKeys,
    led: StructuredLED,
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

