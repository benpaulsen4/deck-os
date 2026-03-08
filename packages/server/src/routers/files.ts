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
        path: z.string().optional().default(""),
        showHidden: z.boolean().optional().default(false),
      })
    )
    .query(async ({ input }) => {
      try {
        return await filesService.listDirectory(input.path, input.showHidden);
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
  setPins: publicProcedure
    .input(
      z.object({
        items: z.array(z.string()),
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
        path: z.string(),
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
        sourcePath: z.string(),
        targetPath: z.string(),
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
        sourcePath: z.string(),
        targetPath: z.string(),
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
        sourcePath: z.string(),
        targetPath: z.string(),
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
        path: z.string(),
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
