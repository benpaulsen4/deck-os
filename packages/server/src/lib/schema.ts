import { z } from "zod";

const AUTH_SESSION_DURATION_MIN_MS = 60 * 60 * 1000;
const AUTH_SESSION_DURATION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_DEFAULT_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

const HttpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const u = new URL(value);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Invalid URL" }
  );

const UrlOrEmptySchema = z.union([HttpUrlSchema, z.literal("")]);
const OptionalUrlSchema = UrlOrEmptySchema.optional().default("");
const UrlOrPathOrEmptySchema = z.union([
  HttpUrlSchema,
  z.string().startsWith("/"),
  z.literal(""),
]);
const OptionalUrlOrPathSchema = UrlOrPathOrEmptySchema.optional().default("");
const AppIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Invalid app id");
const PasscodeSchema = z.string().regex(/^[0-9]{4,10}$/, "Passcode must be 4-10 digits");
const SessionDurationMsSchema = z
  .number()
  .int()
  .min(AUTH_SESSION_DURATION_MIN_MS)
  .max(AUTH_SESSION_DURATION_MAX_MS);

const AppMetadataSchema = z.object({
  id: AppIdSchema,
  name: z.string(),
  icon: OptionalUrlOrPathSchema,
  url: OptionalUrlSchema,
  description: z.string().optional().default(""),
  order: z.number().int().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const ComposeFileSchema = z.object({
  version: z.string().optional(),
  services: z.record(
    z
      .object({
        image: z.string(),
      })
      .passthrough()
  ),
});

const AppSchema = z.object({
  id: AppIdSchema,
  metadata: AppMetadataSchema,
  composeYaml: z.string(),
});

const SystemInfoSchema = z.object({
  hostname: z.string(),
  os: z.string(),
  osDistro: z.string().optional(),
  osRelease: z.string().optional(),
  osArch: z.string().optional(),
  nodeVersion: z.string(),
  uptime: z.number(),
  dockerVersion: z.string().nullable(),
});

const CPUMetricsSchema = z.object({
  usage: z.number(),
  load: z.array(z.number()),
  cores: z.number(),
  speed: z.number().optional(),
  temperatureC: z.number().nullable().optional(),
  powerWatts: z.number().nullable().optional(),
});

const MemoryMetricsSchema = z.object({
  total: z.number(),
  used: z.number(),
  free: z.number(),
  usage: z.number(),
  swapTotal: z.number().optional(),
  swapUsed: z.number().optional(),
  swapFree: z.number().optional(),
  swapUsage: z.number().optional(),
});

const ProcessMetricsSchema = z.object({
  all: z.number(),
  running: z.number(),
  blocked: z.number(),
  sleeping: z.number(),
});

const DiskMetricsSchema = z.object({
  fs: z.array(
    z.object({
      fs: z.string(),
      mount: z.string(),
      size: z.number(),
      used: z.number(),
      usePercent: z.number(),
    })
  ),
});

const NetworkMetricsSchema = z.object({
  interfaces: z.record(
    z.object({
      rx_bytes: z.number(),
      tx_bytes: z.number(),
      rx_sec: z.number(),
      tx_sec: z.number(),
    })
  ),
});

const SystemMetricsSchema = z.object({
  cpu: CPUMetricsSchema,
  memory: MemoryMetricsSchema,
  processes: ProcessMetricsSchema,
  disk: DiskMetricsSchema,
  network: NetworkMetricsSchema,
  timestamp: z.string().datetime(),
});

const ContainerPortSchema = z.object({
  private: z.number(),
  public: z.number().optional(),
  type: z.string().optional(),
  ip: z.string().optional(),
});

const ContainerStateSchema = z.object({
  status: z.string(),
  running: z.boolean(),
  paused: z.boolean(),
  restarting: z.boolean(),
  dead: z.boolean(),
  pid: z.number(),
  exitCode: z.number().optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});

const ContainerStatsSchema = z
  .object({
    cpu: z.number(),
    memory: z.number(),
    memoryBytes: z.number(),
  })
  .optional();

const ContainerInfoSchema = z.object({
  id: z.string(),
  names: z.array(z.string()),
  image: z.string(),
  imageId: z.string(),
  command: z.string().optional(),
  created: z.number(),
  state: ContainerStateSchema,
  status: z.string(),
  ports: z.array(ContainerPortSchema).optional(),
  labels: z.record(z.string()).optional(),
  stats: ContainerStatsSchema,
});

const StackStatusSchema = z.object({
  running: z.number(),
  stopped: z.number(),
  restarting: z.number(),
  containers: z.array(ContainerInfoSchema),
});

const StorageAnalysisMountSchema = z.object({
  id: z.string(),
  mount: z.string(),
  fs: z.string(),
  filesystemType: z.string(),
  size: z.number(),
  used: z.number(),
  deviceId: z.number().nullable(),
});

const StorageAnalysisExtensionLegendEntrySchema = z.object({
  extension: z.string(),
  label: z.string(),
  count: z.number().int(),
  totalSize: z.number(),
  color: z.string(),
});

type StorageAnalysisNode = {
  path: string;
  name: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number;
  extension: string | null;
  childCount: number;
  children: StorageAnalysisNode[];
};

const StorageAnalysisNodeSchema: z.ZodType<StorageAnalysisNode> = z.lazy(() =>
  z.object({
    path: z.string(),
    name: z.string(),
    type: z.enum(["directory", "file", "symlink", "other"]),
    size: z.number(),
    extension: z.string().nullable(),
    childCount: z.number().int(),
    children: z.array(StorageAnalysisNodeSchema),
  })
);

const StorageAnalysisAnalyzerKindSchema = z.enum(["scan"]);
const StorageAnalysisStatusSchema = z.enum(["scanning", "ready", "stale", "failed"]);
const StorageAnalysisErrorCodeSchema = z.enum([
  "permission-denied",
  "unsupported",
  "runtime-failed",
]);
const StorageAnalysisWarningCodeSchema = z.enum(["partial-permissions"]);

const StorageAnalysisSnapshotSchema = z.object({
  mount: StorageAnalysisMountSchema,
  status: StorageAnalysisStatusSchema,
  analyzer: StorageAnalysisAnalyzerKindSchema,
  sourceKind: z.enum(["cache-fresh", "cache-stale", "scan"]),
  mountKey: z.string(),
  generatedAt: z.string().datetime(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  freshnessTtlMs: z.number().int(),
  totalSize: z.number(),
  nodeCount: z.number().int(),
  oversized: z.boolean(),
  extensionHistogram: z.array(StorageAnalysisExtensionLegendEntrySchema),
  root: StorageAnalysisNodeSchema,
  warningCode: StorageAnalysisWarningCodeSchema.nullable().optional(),
  warning: z.string().nullable().optional(),
});

const StorageAnalysisResponseSchema = z.object({
  mount: StorageAnalysisMountSchema,
  status: StorageAnalysisStatusSchema,
  analyzer: StorageAnalysisAnalyzerKindSchema.nullable(),
  sourceKind: z.enum(["cache-fresh", "cache-stale", "scan", "pending"]).nullable(),
  jobId: z.string().nullable(),
  mountKey: z.string(),
  generatedAt: z.string().datetime().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  freshnessTtlMs: z.number().int(),
  totalSize: z.number().nullable(),
  nodeCount: z.number().int().nullable(),
  isPartial: z.boolean(),
  oversized: z.boolean(),
  extensionHistogram: z.array(StorageAnalysisExtensionLegendEntrySchema),
  root: StorageAnalysisNodeSchema.nullable(),
  refreshing: z.boolean(),
  errorCode: StorageAnalysisErrorCodeSchema.nullable(),
  error: z.string().nullable(),
  warningCode: StorageAnalysisWarningCodeSchema.nullable(),
  warning: z.string().nullable(),
});

const StorageAnalysisJobSchema = z.object({
  jobId: z.string(),
  mountKey: z.string(),
  startedAt: z.string().datetime(),
  status: z.enum(["scanning", "ready", "failed"]),
});

const StorageAnalysisStartResponseSchema = z.object({
  job: StorageAnalysisJobSchema,
});

const StorageAnalysisNodePatchSchema = z.object({
  parentPath: z.string().nullable(),
  path: z.string(),
  name: z.string(),
  type: z.enum(["directory", "file", "symlink", "other"]),
  size: z.number(),
  extension: z.string().nullable(),
});

const StorageAnalysisStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    job: StorageAnalysisJobSchema,
    mount: StorageAnalysisMountSchema,
  }),
  z.object({
    type: z.literal("node"),
    node: StorageAnalysisNodePatchSchema,
    totalSize: z.number(),
    nodeCount: z.number().int(),
  }),
  z.object({
    type: z.literal("progress"),
    totalSize: z.number(),
    nodeCount: z.number().int(),
    warningCode: StorageAnalysisWarningCodeSchema.nullable(),
    warning: z.string().nullable(),
    extensionHistogram: z.array(StorageAnalysisExtensionLegendEntrySchema),
  }),
  z.object({
    type: z.literal("done"),
    completedAt: z.string().datetime(),
    totalSize: z.number(),
    nodeCount: z.number().int(),
    warningCode: StorageAnalysisWarningCodeSchema.nullable(),
    warning: z.string().nullable(),
  }),
  z.object({
    type: z.literal("failed"),
    errorCode: StorageAnalysisErrorCodeSchema,
    error: z.string(),
  }),
]);

type AppMetadata = z.infer<typeof AppMetadataSchema>;
type ComposeFile = z.infer<typeof ComposeFileSchema>;
type App = z.infer<typeof AppSchema>;
type SystemInfo = z.infer<typeof SystemInfoSchema>;
type SystemMetrics = z.infer<typeof SystemMetricsSchema>;
type CPUMetrics = z.infer<typeof CPUMetricsSchema>;
type MemoryMetrics = z.infer<typeof MemoryMetricsSchema>;
type DiskMetrics = z.infer<typeof DiskMetricsSchema>;
type NetworkMetrics = z.infer<typeof NetworkMetricsSchema>;
type ProcessMetrics = z.infer<typeof ProcessMetricsSchema>;
type ContainerInfo = z.infer<typeof ContainerInfoSchema>;
type ContainerState = z.infer<typeof ContainerStateSchema>;
type StackStatus = z.infer<typeof StackStatusSchema>;
type StorageAnalysisMount = z.infer<typeof StorageAnalysisMountSchema>;
type StorageAnalysisExtensionLegendEntry = z.infer<
  typeof StorageAnalysisExtensionLegendEntrySchema
>;
type StorageAnalysisAnalyzerKind = z.infer<typeof StorageAnalysisAnalyzerKindSchema>;
type StorageAnalysisStatus = z.infer<typeof StorageAnalysisStatusSchema>;
type StorageAnalysisErrorCode = z.infer<typeof StorageAnalysisErrorCodeSchema>;
type StorageAnalysisWarningCode = z.infer<typeof StorageAnalysisWarningCodeSchema>;
type StorageAnalysisSnapshot = z.infer<typeof StorageAnalysisSnapshotSchema>;
type StorageAnalysisResponse = z.infer<typeof StorageAnalysisResponseSchema>;
type StorageAnalysisJob = z.infer<typeof StorageAnalysisJobSchema>;
type StorageAnalysisStartResponse = z.infer<typeof StorageAnalysisStartResponseSchema>;
type StorageAnalysisNodePatch = z.infer<typeof StorageAnalysisNodePatchSchema>;
type StorageAnalysisStreamEvent = z.infer<typeof StorageAnalysisStreamEventSchema>;

export {
  AppMetadataSchema,
  ComposeFileSchema,
  AppSchema,
  SystemInfoSchema,
  SystemMetricsSchema,
  CPUMetricsSchema,
  MemoryMetricsSchema,
  ProcessMetricsSchema,
  DiskMetricsSchema,
  NetworkMetricsSchema,
  ContainerInfoSchema,
  ContainerStateSchema,
  ContainerPortSchema,
  StackStatusSchema,
  StorageAnalysisMountSchema,
  StorageAnalysisNodeSchema,
  StorageAnalysisExtensionLegendEntrySchema,
  StorageAnalysisAnalyzerKindSchema,
  StorageAnalysisStatusSchema,
  StorageAnalysisErrorCodeSchema,
  StorageAnalysisWarningCodeSchema,
  StorageAnalysisSnapshotSchema,
  StorageAnalysisResponseSchema,
  StorageAnalysisJobSchema,
  StorageAnalysisStartResponseSchema,
  StorageAnalysisNodePatchSchema,
  StorageAnalysisStreamEventSchema,
  UrlOrEmptySchema,
  OptionalUrlSchema,
  OptionalUrlOrPathSchema,
  AppIdSchema,
  PasscodeSchema,
  SessionDurationMsSchema,
  AUTH_SESSION_DURATION_MIN_MS,
  AUTH_SESSION_DURATION_MAX_MS,
  AUTH_DEFAULT_SESSION_DURATION_MS,
};

export type {
  AppMetadata,
  ComposeFile,
  App,
  SystemInfo,
  SystemMetrics,
  CPUMetrics,
  MemoryMetrics,
  ProcessMetrics,
  DiskMetrics,
  NetworkMetrics,
  ContainerInfo,
  ContainerState,
  StackStatus,
  StorageAnalysisMount,
  StorageAnalysisNode,
  StorageAnalysisExtensionLegendEntry,
  StorageAnalysisAnalyzerKind,
  StorageAnalysisStatus,
  StorageAnalysisErrorCode,
  StorageAnalysisWarningCode,
  StorageAnalysisSnapshot,
  StorageAnalysisResponse,
  StorageAnalysisJob,
  StorageAnalysisStartResponse,
  StorageAnalysisNodePatch,
  StorageAnalysisStreamEvent,
};
