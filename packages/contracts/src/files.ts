import { z } from "zod";
import { AbsolutePathSchema } from "./common.js";
import { getPathParent } from "./paths.js";

const FilesRouteSourceSchema = z.enum(["disk-analysis"]);

const FilesRouteSearchSchema = z.object({
  path: AbsolutePathSchema.optional(),
  reveal: AbsolutePathSchema.optional(),
  source: FilesRouteSourceSchema.optional(),
});

type FilesRouteSearch = z.infer<typeof FilesRouteSearchSchema>;

function getFilesRouteTargetPath(search: FilesRouteSearch): string {
  if (search.path) {
    return search.path;
  }
  if (search.reveal) {
    return getPathParent(search.reveal);
  }
  return "";
}

export { FilesRouteSearchSchema, FilesRouteSourceSchema, getFilesRouteTargetPath };
export type { FilesRouteSearch };
