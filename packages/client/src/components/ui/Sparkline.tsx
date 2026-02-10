import { useMemo } from "react";

interface SparklineProps {
  values: number[];
  color: string;
  width?: number;
  height?: number;
}

export function Sparkline({ values, color, width = 160, height = 32 }: SparklineProps) {
  const points = useMemo(() => {
    if (values.length === 0) return "";

    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = max - min || 1;

    const stepX = width / Math.max(values.length - 1, 1);

    return values
      .map((value, index) => {
        const x = index * stepX;
        const normalizedValue = (value - min) / range;
        const y = height - normalizedValue * height;
        return `${x},${y}`;
      })
      .join(" ");
  }, [values, width, height]);

  if (values.length === 0) {
    return (
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block" }}>
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke={color}
          strokeWidth={1}
          opacity={0.2}
        />
      </svg>
    );
  }

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block" }}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}