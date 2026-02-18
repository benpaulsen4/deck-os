import { useMemo } from "react";

interface SparklineProps {
  values: Array<number | null | undefined>;
  color: string;
  width?: number;
  height?: number;
  showBounds?: boolean;
  formatValue?: (value: number) => string;
  minValue?: number;
  maxValue?: number;
}

export function Sparkline({
  values,
  color,
  width = 160,
  height = 32,
  showBounds = false,
  formatValue,
  minValue,
  maxValue,
}: SparklineProps) {
  const { points, min, max } = useMemo(() => {
    const finiteValues = values.filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v)
    );
    if (finiteValues.length === 0) return { points: "", min: 0, max: 0 };

    const dataMax = Math.max(...finiteValues);
    const dataMin = Math.min(...finiteValues);
    const computedMin =
      typeof minValue === "number" && Number.isFinite(minValue) ? minValue : dataMin;
    const computedMax =
      typeof maxValue === "number" && Number.isFinite(maxValue) ? maxValue : dataMax;

    let min = computedMin;
    let max = computedMax;
    if (max === min) {
      const pad = max === 0 ? 1 : Math.abs(max) * 0.25;
      min = min - pad;
      max = max + pad;
    } else if (typeof minValue !== "number" || typeof maxValue !== "number") {
      const pad = (max - min) * 0.1;
      min = min - pad;
      max = max + pad;
    }

    if (dataMin >= 0) {
      min = Math.max(0, min);
    }

    const range = max - min || 1;

    const stepX = width / Math.max(finiteValues.length - 1, 1);

    const points = finiteValues
      .map((value, index) => {
        const x = index * stepX;
        const normalizedValue = (value - min) / range;
        const y = height - normalizedValue * height;
        return `${x},${y}`;
      })
      .join(" ");

    return { points, min, max };
  }, [values, width, height, minValue, maxValue]);

  if (!points) {
    return (
      <div className="sparkline" style={{ height }}>
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          style={{ display: "block" }}
        >
          <line
            x1={0}
            y1={height / 2}
            x2={width}
            y2={height / 2}
            stroke={color}
            strokeWidth={1}
            opacity={0.2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    );
  }

  const maxLabel = formatValue ? formatValue(max) : String(max);
  const minLabel = formatValue ? formatValue(min) : String(min);

  return (
    <div className="sparkline" style={{ height }}>
      {showBounds ? (
        <>
          <div className="sparkline-label sparkline-label-max" style={{ color }}>
            {maxLabel}
          </div>
          <div className="sparkline-label sparkline-label-min" style={{ color }}>
            {minLabel}
          </div>
        </>
      ) : null}
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ display: "block" }}
      >
        {showBounds ? (
          <>
            <line
              x1={0}
              y1={0.5}
              x2={width}
              y2={0.5}
              stroke={color}
              strokeWidth={1}
              opacity={0.12}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={0}
              y1={height - 0.5}
              x2={width}
              y2={height - 0.5}
              stroke={color}
              strokeWidth={1}
              opacity={0.12}
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : null}
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
