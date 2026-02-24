
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

const ProfileIndicators = z.object({
  USB: z.string().optional(),
  BT1: z.string().optional(),
  BT2: z.string().optional(),
  BT3: z.string().optional(),
  BT4: z.string().optional()
}).strict().optional();

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
  legends: z.record(z.string()).optional(),
  profileIndicators: ProfileIndicators
}).superRefine((layout, ctx) => {
  const indicators = layout.profileIndicators;
  if (!indicators) return;

  if (!layout.colorDefinitions) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["colorDefinitions"],
      message: "colorDefinitions is required when profileIndicators is set"
    });
    return;
  }

  for (const [profile, colorName] of Object.entries(indicators)) {
    if (!colorName) continue;
    if (!layout.colorDefinitions[colorName]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["profileIndicators", profile],
        message: `Unknown color '${colorName}' in profileIndicators.${profile}`
      });
    }
  }
});
export type Layout = z.infer<typeof Layout>;
