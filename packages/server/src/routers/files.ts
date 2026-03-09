import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, publicProcedure } from "../trpc/trpc.js";
import * as filesService from "../services/files.js";

function toTrpcError(error: unknown): TRPCError {
  if (error instanceof filesService.FilesAccessDeniedError) {
    return new TRPCError({ code: "FORBIDDEN", message: error.message });
  }
  if (error instanceof filesService.FilesNotFoundError) {
    return new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  if (error instanceof filesService.FilesNotDirectoryError) {
    return new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  if (error instanceof filesService.FilesNotFileError) {
    return new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  if (error instanceof filesService.FilesAlreadyExistsError) {
    return new TRPCError({ code: "CONFLICT", message: error.message });
  }
  if (error instanceof Error) {
    return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: String(error) });
}

export const filesRouter = router({
  list: publicProcedure
    .input(
      z.object({
        path: z.string().max(4096).optional().default(""),
        showHidden: z.boolean().optional().default(false),
        directoriesOnly: z.boolean().optional().default(false),
      })
    )
    .query(async ({ input }) => {
      try {
        return await filesService.listDirectory(input.path, {
          showHidden: input.showHidden,
          directoriesOnly: input.directoriesOnly,
        });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  getPins: publicProcedure.query(async () => {
    try {
      const items = await filesService.getPins();
      return { items };
    } catch (error) {
      throw toTrpcError(error);
    }
  }),
  getMeta: publicProcedure
    .input(
      z.object({
        path: z.string().min(1).max(4096),
      })
    )
    .query(async ({ input }) => {
      try {
        return await filesService.getMeta(input.path);
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  readText: publicProcedure
    .input(
      z.object({
        path: z.string().min(1).max(4096),
        forceEditable: z.boolean().optional().default(false),
      })
    )
    .query(async ({ input }) => {
      try {
        return await filesService.readText(input.path, input.forceEditable);
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  writeText: publicProcedure
    .input(
      z.object({
        path: z.string().min(1).max(4096),
        content: z.string().max(4 * 1024 * 1024),
      })
    )
    .mutation(async ({ input }) => {
      try {
        await filesService.writeText(input.path, input.content);
        return { success: true };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  setPins: publicProcedure
    .input(
      z.object({
        items: z.array(z.string().min(1).max(4096)).max(64),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const items = await filesService.setPins(input.items);
        return { items };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  mkdir: publicProcedure
    .input(
      z.object({
        path: z.string().min(1).max(4096),
      })
    )
    .mutation(async ({ input }) => {
      try {
        await filesService.mkdir(input.path);
        return { success: true };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  rename: publicProcedure
    .input(
      z.object({
        sourcePath: z.string().min(1).max(4096),
        targetPath: z.string().min(1).max(4096),
      })
    )
    .mutation(async ({ input }) => {
      try {
        await filesService.rename(input.sourcePath, input.targetPath);
        return { success: true };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  copy: publicProcedure
    .input(
      z.object({
        sourcePath: z.string().min(1).max(4096),
        targetPath: z.string().min(1).max(4096),
      })
    )
    .mutation(async ({ input }) => {
      try {
        await filesService.copy(input.sourcePath, input.targetPath);
        return { success: true };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  move: publicProcedure
    .input(
      z.object({
        sourcePath: z.string().min(1).max(4096),
        targetPath: z.string().min(1).max(4096),
      })
    )
    .mutation(async ({ input }) => {
      try {
        await filesService.move(input.sourcePath, input.targetPath);
        return { success: true };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  delete: publicProcedure
    .input(
      z.object({
        path: z.string().min(1).max(4096),
      })
    )
    .mutation(async ({ input }) => {
      try {
        await filesService.remove(input.path);
        return { success: true };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
});
