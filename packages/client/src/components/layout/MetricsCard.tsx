import type { ReactNode } from "react";
import { type SystemMetrics } from "../../../../server/src/lib/schema.js";
import { Sparkline } from "../ui/Sparkline";
import { useMetricsStore } from "../../stores/metrics";

interface MetricsCardProps {
  label: string;
  color: string;
  value: ReactNode;
  usage: number;
  historyValues: (metrics: SystemMetrics) => number;
  formatSparkValue?: (value: number) => string;
  sparkMin?: number;
  sparkMax?: number;
}

export function MetricsCard({
  label,
  color,
  value,
  usage,
  historyValues,
  formatSparkValue,
  sparkMin,
  sparkMax,
}: MetricsCardProps) {
  const metrics = useMetricsStore();

  const history = metrics
    .getHistory(60)
    .map(historyValues)
    .filter((v) => Number.isFinite(v));
  const displayUsage = Math.min(100, usage);

  return (
    <div className="panel metric-card">
      <div className="metric-card-header">
        <span className="label">{label}</span>
      </div>
      <div className="metric-card-value">{value}</div>
      <div className="metric-card-bar-container">
        <div
          className="metric-card-bar-fill"
          style={{
            width: `${displayUsage}%`,
            background: color,
            transition: "width var(--transition-meter) linear",
          }}
        />
      </div>
      <div className="metric-card-sparkline">
        <Sparkline
          values={history}
          color={color}
          width={160}
          height={32}
          showBounds
          formatValue={formatSparkValue}
          minValue={sparkMin}
          maxValue={sparkMax}
        />
      </div>
    </div>
  );
}
