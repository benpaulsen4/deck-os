import { z } from "zod";

function isAbsolutePath(value: string): boolean {
  if (value.startsWith("/")) {
    return true;
  }
  if (/^[A-Za-z]:$/.test(value)) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return true;
  }
  return /^\\\\[^\\/?%*:|"<>]+\\[^\\/?%*:|"<>]+/.test(value);
}

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsolutePath, "Absolute path required");

const MountFsSchema = z.string().min(1).max(1024);
const IsoTimestampSchema = z.string().datetime();

export { AbsolutePathSchema, IsoTimestampSchema, MountFsSchema };
