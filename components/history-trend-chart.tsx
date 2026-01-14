"use client";

import { useMemo } from "react";
import { Line, LineChart, XAxis, YAxis, ReferenceLine } from "recharts";
import type { AvailabilityPeriod, TrendDataPoint } from "@/lib/types";
import { STATUS_META } from "@/lib/core/status";
import { ClientTime } from "@/components/client-time";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart";

interface HistoryTrendChartProps {
  data?: TrendDataPoint[] | null;
  period: AvailabilityPeriod;
  isMaintenance?: boolean;
}

const PERIOD_LABELS: Record<AvailabilityPeriod, string> = {
  "7d": "7 天",
  "15d": "15 天",
  "30d": "30 天",
};

// 与 STATUS_META 保持一致的颜色
const STATUS_COLORS: Record<TrendDataPoint["status"], string> = {
  operational: "oklch(0.696 0.17 162.48)", // emerald-500
  degraded: "oklch(0.769 0.188 70.08)", // amber-500
  failed: "oklch(0.645 0.246 16.439)", // rose-500
  error: "oklch(0.577 0.245 27.325)", // red-600
  validation_failed: "oklch(0.705 0.213 47.604)", // orange-500
  maintenance: "oklch(0.623 0.214 259.815)", // blue-500
};

const chartConfig = {
  latencyMs: {
    label: "延迟",
    color: "oklch(0.696 0.17 162.48)",
  },
} satisfies ChartConfig;

// 最大显示数据点数量，超过此值将进行采样
const MAX_VISIBLE_DOTS = 30;

interface SampledDataPoint extends TrendDataPoint {
  index: number;
  fill: string;
  displayLatency: number;
  isKeyPoint: boolean; // 是否为关键点（状态变化、极值）
}

/**
 * 智能数据采样：保留关键点（首尾、状态变化、极值），等间隔采样其余点
 */
function sampleDataPoints(
  points: TrendDataPoint[],
  maxPoints: number
): { sampledPoints: TrendDataPoint[]; keyPointIndices: Set<number> } {
  if (points.length <= maxPoints) {
    // 不需要采样，标记所有状态变化点和极值点为关键点
    const keyPointIndices = new Set<number>();
    let minLatency = Infinity;
    let maxLatency = -Infinity;
    let minIdx = 0;
    let maxIdx = 0;

    points.forEach((p, i) => {
      if (typeof p.latencyMs === "number") {
        if (p.latencyMs < minLatency) {
          minLatency = p.latencyMs;
          minIdx = i;
        }
        if (p.latencyMs > maxLatency) {
          maxLatency = p.latencyMs;
          maxIdx = i;
        }
      }
      // 状态变化点
      if (i > 0 && points[i - 1].status !== p.status) {
        keyPointIndices.add(i);
        keyPointIndices.add(i - 1);
      }
    });

    // 首尾点和极值点
    keyPointIndices.add(0);
    keyPointIndices.add(points.length - 1);
    keyPointIndices.add(minIdx);
    keyPointIndices.add(maxIdx);

    return { sampledPoints: points, keyPointIndices };
  }

  // 需要采样
  const keyPointIndices = new Set<number>();
  const mustInclude = new Set<number>();

  // 1. 标记必须包含的点：首尾
  mustInclude.add(0);
  mustInclude.add(points.length - 1);

  // 2. 标记状态变化点
  for (let i = 1; i < points.length; i++) {
    if (points[i - 1].status !== points[i].status) {
      mustInclude.add(i - 1);
      mustInclude.add(i);
    }
  }

  // 3. 标记极值点
  let minLatency = Infinity;
  let maxLatency = -Infinity;
  let minIdx = 0;
  let maxIdx = 0;
  points.forEach((p, i) => {
    if (typeof p.latencyMs === "number") {
      if (p.latencyMs < minLatency) {
        minLatency = p.latencyMs;
        minIdx = i;
      }
      if (p.latencyMs > maxLatency) {
        maxLatency = p.latencyMs;
        maxIdx = i;
      }
    }
  });
  mustInclude.add(minIdx);
  mustInclude.add(maxIdx);

  // 4. 计算采样间隔，填充剩余点
  const remainingSlots = maxPoints - mustInclude.size;
  const selectedIndices = new Set(mustInclude);

  if (remainingSlots > 0) {
    const step = points.length / remainingSlots;
    for (let i = 0; i < remainingSlots; i++) {
      const idx = Math.min(Math.floor(i * step), points.length - 1);
      selectedIndices.add(idx);
    }
  }

  // 5. 按原顺序排列采样点
  const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
  const sampledPoints = sortedIndices.map((i) => points[i]);

  // 6. 标记采样后的关键点索引
  sortedIndices.forEach((originalIdx, newIdx) => {
    if (mustInclude.has(originalIdx)) {
      keyPointIndices.add(newIdx);
    }
  });

  return { sampledPoints, keyPointIndices };
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: SampledDataPoint }>;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const point = payload[0].payload;
  const statusMeta = STATUS_META[point.status];

  return (
    <div className="rounded-lg border border-border/60 bg-background/95 p-2 text-xs shadow-lg">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: STATUS_COLORS[point.status] }}
          />
          <span className="font-medium text-foreground">
            {statusMeta?.label ?? point.status}
          </span>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {typeof point.latencyMs === "number" ? `${point.latencyMs} ms` : "—"}
        </span>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        <ClientTime value={point.timestamp} />
      </p>
    </div>
  );
}

export function HistoryTrendChart({ data, period, isMaintenance }: HistoryTrendChartProps) {
  const points = useMemo(() => (data ? [...data] : []), [data]);

  const { minLatency, maxLatency, avgLatency } = useMemo(() => {
    const latencies = points
      .map((point) => point.latencyMs)
      .filter((value): value is number => typeof value === "number");

    if (latencies.length === 0) {
      return { minLatency: 0, maxLatency: 0, avgLatency: 0 };
    }

    const min = Math.min(...latencies);
    const max = Math.max(...latencies);
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);

    return { minLatency: min, maxLatency: max, avgLatency: avg };
  }, [points]);

  const chartData = useMemo((): SampledDataPoint[] => {
    const { sampledPoints, keyPointIndices } = sampleDataPoints(points, MAX_VISIBLE_DOTS);
    return sampledPoints.map((point, index) => ({
      ...point,
      index,
      fill: STATUS_COLORS[point.status],
      displayLatency: point.latencyMs ?? minLatency,
      isKeyPoint: keyPointIndices.has(index),
    }));
  }, [points, minLatency]);

  if (!points.length) {
    if (isMaintenance) {
      return (
        <div className="rounded-lg border border-dashed border-blue-500/30 bg-blue-500/5 px-3 py-3 text-xs text-blue-500">
          维护中 · 已暂停 {PERIOD_LABELS[period]} 延迟趋势采集
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-dashed border-border/50 bg-muted/10 px-3 py-3 text-xs text-muted-foreground">
        暂无 {PERIOD_LABELS[period]} 趋势数据
      </div>
    );
  }

  const yDomain = [
    Math.max(0, minLatency - (maxLatency - minLatency) * 0.1),
    maxLatency + (maxLatency - minLatency) * 0.1,
  ];

  // 维护模式下用蓝色样式包装
  const wrapperClass = isMaintenance
    ? "space-y-2 rounded-lg border border-dashed border-blue-500/30 bg-blue-500/5 p-2"
    : "space-y-2";
  const titleClass = isMaintenance
    ? "text-[10px] font-semibold uppercase tracking-wider text-blue-500"
    : "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground";

  return (
    <div className={wrapperClass}>
      <div className={`flex items-center justify-between ${titleClass}`}>
        <span>
          {isMaintenance ? "维护前延迟趋势" : "延迟趋势"} ({PERIOD_LABELS[period]})
        </span>
        <span className={`font-mono text-[10px] ${isMaintenance ? "text-blue-500/70" : ""}`}>
          {minLatency.toFixed(0)}-{maxLatency.toFixed(0)} ms
        </span>
      </div>

      <ChartContainer config={chartConfig} className="h-20 w-full">
        <LineChart
          data={chartData}
          margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
        >
          <XAxis dataKey="index" hide />
          <YAxis domain={yDomain} hide />
          <ReferenceLine
            y={avgLatency}
            stroke="var(--muted-foreground)"
            strokeDasharray="3 3"
            strokeOpacity={0.3}
          />
          <ChartTooltip
            content={<CustomTooltip />}
            cursor={{
              stroke: "var(--muted-foreground)",
              strokeWidth: 1,
              strokeDasharray: "4 4",
            }}
          />
          <Line
            type="monotone"
            dataKey="displayLatency"
            stroke="var(--primary)"
            strokeWidth={1.5}
            dot={({ cx, cy, payload }) => {
              // 只在关键点显示圆点
              if (!payload.isKeyPoint) {
                return <circle key={`dot-${payload.index}`} r={0} />;
              }
              return (
                <circle
                  key={`dot-${payload.index}`}
                  cx={cx}
                  cy={cy}
                  r={3}
                  fill={payload.fill}
                  strokeWidth={0}
                />
              );
            }}
            activeDot={{
              r: 5,
              strokeWidth: 2,
              stroke: "var(--background)",
            }}
          />
        </LineChart>
      </ChartContainer>
    </div>
  );
}
