export function createStorageMountId(mount: string, fs: string): string {
  const input = `${fs}\0${mount}`;
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return Math.abs(hash >>> 0).toString(36);
}

export function formatStorageTimestamp(value: string | null): string {
  if (!value) {
    return "Not available";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }
  return date.toLocaleString();
}

export function formatStorageBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) {
    return "0 B";
  }
  if (bytes === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatRelativeFreshness(
  completedAt: string | null,
  ttlMs: number
): string {
  if (!completedAt) {
    return "Pending";
  }
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(completedMs)) {
    return "Pending";
  }
  const ageMs = Math.max(0, Date.now() - completedMs);
  if (ageMs < 1000) {
    return "Just now";
  }
  if (ageMs < 60_000) {
    return `${Math.round(ageMs / 1000)}s old`;
  }
  if (ageMs < 60 * 60_000) {
    return `${Math.round(ageMs / 60_000)}m old`;
  }
  const hours = (ageMs / (60 * 60_000)).toFixed(1);
  if (ageMs <= ttlMs) {
    return `${hours}h old`;
  }
  return `Stale (${hours}h old)`;
}
