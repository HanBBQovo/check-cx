import {NextResponse} from "next/server";

import {loadDashboardData} from "@/lib/core/dashboard-data";
import {getPollingIntervalMs} from "@/lib/core/polling-config";
import type {AvailabilityPeriod} from "@/lib/types";

export const revalidate = 0;
export const dynamic = "force-dynamic";

const VALID_PERIODS: AvailabilityPeriod[] = ["7d", "15d", "30d"];

/** 数据变化周期：5 分钟 */
const DATA_CHANGE_CYCLE_SECONDS = 5 * 60;

/**
 * 生成简单的哈希作为 ETag
 * 使用 djb2 算法，足够快且碰撞率低
 */
function generateETag(data: string): string {
  let hash = 5381;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) + hash) ^ data.charCodeAt(i);
  }
  // 转为无符号 32 位整数的十六进制
  return `"${(hash >>> 0).toString(16)}"`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("trendPeriod");
  const forceRefreshParam = searchParams.get("forceRefresh");
  const shouldForceRefresh =
    forceRefreshParam === "1" || forceRefreshParam === "true";
  const trendPeriod = VALID_PERIODS.includes(period as AvailabilityPeriod)
    ? (period as AvailabilityPeriod)
    : undefined;

  const data = await loadDashboardData({
    refreshMode: shouldForceRefresh ? "always" : "never",
    trendPeriod,
  });

  // 生成 ETag（基于数据内容）
  const { generatedAt, ...etagPayload } = data;
  void generatedAt;
  const jsonBody = JSON.stringify(etagPayload);
  const etag = generateETag(jsonBody);

  // 检查条件请求
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch === etag) {
    // 数据未变，返回 304
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
      },
    });
  }

  // 计算缓存时间
  const pollIntervalSeconds = Math.floor(getPollingIntervalMs() / 1000);

  // 构建响应
  const response = NextResponse.json(data);

  // 设置缓存头
  // Cache-Control: 浏览器每次都向 CDN 验证
  response.headers.set("Cache-Control", "public, no-cache");

  // CDN-Cache-Control: Cloudflare 边缘节点缓存
  response.headers.set("CDN-Cache-Control", `max-age=${pollIntervalSeconds}`);

  // Cloudflare-CDN-Cache-Control: 支持 stale-while-revalidate
  response.headers.set(
    "Cloudflare-CDN-Cache-Control",
    `max-age=${pollIntervalSeconds}, stale-while-revalidate=${DATA_CHANGE_CYCLE_SECONDS}`
  );

  // ETag
  response.headers.set("ETag", etag);

  // Vary: 确保不同参数的请求分开缓存
  response.headers.set("Vary", "Accept-Encoding");

  return response;
}
