import { z } from "zod";

export const ComposeFileSchema = z.object({
  version: z.string().optional(),
  services: z.record(
    z.string(),
    z
      .object({
        image: z.string(),
      })
      .passthrough()
  ),
});
