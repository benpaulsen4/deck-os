import { z } from "zod";

const AppMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().url().optional().default(""),
  url: z.string().url().optional().default(""),
  description: z.string().optional().default(""),
  order: z.number().int().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const ComposeFileSchema = z.object({
  version: z.string().optional(),
  services: z.record(z.object({
    image: z.string(),
  }).passthrough()),
});

const AppSchema = z.object({
  id: z.string(),
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
});

const MemoryMetricsSchema = z.object({
  total: z.number(),
  used: z.number(),
  free: z.number(),
  usage: z.number(),
});

const DiskMetricsSchema = z.object({
  fs: z.array(z.object({
    fs: z.string(),
    mount: z.string(),
    size: z.number(),
    used: z.number(),
    usePercent: z.number(),
  })),
});

const NetworkMetricsSchema = z.object({
  interfaces: z.record(z.object({
    rx_bytes: z.number(),
    tx_bytes: z.number(),
    rx_sec: z.number(),
    tx_sec: z.number(),
  })),
});

const SystemMetricsSchema = z.object({
  cpu: CPUMetricsSchema,
  memory: MemoryMetricsSchema,
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
});

const StackStatusSchema = z.object({
  running: z.number(),
  stopped: z.number(),
  restarting: z.number(),
  containers: z.array(ContainerInfoSchema),
});

type AppMetadata = z.infer<typeof AppMetadataSchema>;
type ComposeFile = z.infer<typeof ComposeFileSchema>;
type App = z.infer<typeof AppSchema>;
type SystemInfo = z.infer<typeof SystemInfoSchema>;
type SystemMetrics = z.infer<typeof SystemMetricsSchema>;
type CPUMetrics = z.infer<typeof CPUMetricsSchema>;
type MemoryMetrics = z.infer<typeof MemoryMetricsSchema>;
type DiskMetrics = z.infer<typeof DiskMetricsSchema>;
type NetworkMetrics = z.infer<typeof NetworkMetricsSchema>;
type ContainerInfo = z.infer<typeof ContainerInfoSchema>;
type ContainerState = z.infer<typeof ContainerStateSchema>;
type StackStatus = z.infer<typeof StackStatusSchema>;

export {
  AppMetadataSchema,
  ComposeFileSchema,
  AppSchema,
  SystemInfoSchema,
  SystemMetricsSchema,
  CPUMetricsSchema,
  MemoryMetricsSchema,
  DiskMetricsSchema,
  NetworkMetricsSchema,
  ContainerInfoSchema,
  ContainerStateSchema,
  ContainerPortSchema,
  StackStatusSchema,
};

export type {
  AppMetadata,
  ComposeFile,
  App,
  SystemInfo,
  SystemMetrics,
  CPUMetrics,
  MemoryMetrics,
  DiskMetrics,
  NetworkMetrics,
  ContainerInfo,
  ContainerState,
  StackStatus,
};