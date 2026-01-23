import { NextResponse } from "next/server";
import { getAvailabilityCacheMetrics, resetAvailabilityCacheMetrics } from "@/lib/database/availability";
import { getConfigCacheMetrics, resetConfigCacheMetrics } from "@/lib/database/config-loader";
import { getGroupInfoCacheMetrics, resetGroupInfoCacheMetrics } from "@/lib/database/group-info";
import { getDashboardCacheMetrics, resetDashboardCacheMetrics } from "@/lib/core/dashboard-data";

export const revalidate = 0;
export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  const token = process.env.INTERNAL_METRICS_TOKEN;
  if (!token) {
    return false;
  }
  const headerToken = request.headers.get("x-internal-token");
  return headerToken === token;
}

function buildMetricsResponse() {
  const availability = getAvailabilityCacheMetrics();
  const config = getConfigCacheMetrics();
  const groupInfo = getGroupInfoCacheMetrics();
  const dashboard = getDashboardCacheMetrics();

  return NextResponse.json({
    availabilityCache: availability,
    configCache: config,
    groupInfoCache: groupInfo,
    dashboardCache: dashboard,
    combinedDbCache: {
      hits: availability.hits + config.hits + groupInfo.hits,
      misses: availability.misses + config.misses + groupInfo.misses,
    },
    generatedAt: new Date().toISOString(),
  });
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return buildMetricsResponse();
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  resetAvailabilityCacheMetrics();
  resetConfigCacheMetrics();
  resetGroupInfoCacheMetrics();
  resetDashboardCacheMetrics();

  return buildMetricsResponse();
}
