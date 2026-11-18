import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const outlineSettingsSchema = z.object({
  followVisibleSession: z.boolean().default(true),
  openPreviewOnRowClick: z.boolean().default(false),
});

export type OutlineSettingsValues = z.infer<typeof outlineSettingsSchema>;

export const DEFAULT_OUTLINE_SETTINGS: OutlineSettingsValues = {
  followVisibleSession: true,
  openPreviewOnRowClick: false,
};

export const outlineSettings = defineSettings({
  id: "outline",
  scope: "host",
  version: 1,
  schema: outlineSettingsSchema,
});
