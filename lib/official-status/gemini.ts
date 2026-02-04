/**
 * Gemini 官方状态检查器（Google Cloud Status）
 *
 * 说明：
 * - Gemini（本项目中的 type=gemini）没有公开的 StatusPage（如 statuspage.io）API。
 * - 这里使用 Google Cloud Status 的 incidents.json，并以产品 "Vertex Gemini API" 作为官方状态参考。
 */

import type {OfficialHealthStatus, OfficialStatusResult} from "../types";
import {logError} from "../utils/error-handler";

const GOOGLE_CLOUD_INCIDENTS_URL = "https://status.cloud.google.com/incidents.json";
const TIMEOUT_MS = 15000; // 15 秒超时

const GEMINI_PRODUCT_TITLE = "Vertex Gemini API";

interface GoogleCloudIncident {
  number?: string | number;
  begin?: string | null;
  end?: string | null;
  severity?: string | null;
  status_impact?: string | null;
  affected_products?: Array<{
    title?: string | null;
  }> | null;
}

function isGeminiRelatedIncident(incident: GoogleCloudIncident): boolean {
  const products = incident.affected_products ?? [];
  return products.some((product) => (product?.title ?? "") === GEMINI_PRODUCT_TITLE);
}

function isActiveIncident(incident: GoogleCloudIncident): boolean {
  // Google Cloud Status 的 incidents.json 同时包含历史与进行中事件：
  // - 进行中通常 end 为 null
  // - 极少数情况下 end 可能是未来时间
  const end = incident.end;
  if (end === null || end === undefined) return true;
  const endMs = Date.parse(end);
  return Number.isFinite(endMs) && endMs > Date.now();
}

function toStatus(incidents: GoogleCloudIncident[]): OfficialHealthStatus {
  // 优先使用 status_impact（SERVICE_OUTAGE / SERVICE_DISRUPTION），再回退到 severity。
  let status: OfficialHealthStatus = "degraded";
  for (const incident of incidents) {
    const impact = (incident.status_impact ?? "").toUpperCase();
    if (impact.includes("OUTAGE")) {
      return "down";
    }
    if (impact.includes("DISRUPTION")) {
      status = "degraded";
      continue;
    }

    const severity = (incident.severity ?? "").toLowerCase();
    if (severity === "high") {
      return "down";
    }
    if (severity === "medium" || severity === "low") {
      status = "degraded";
    }
  }
  return status;
}

function formatMessage(incidents: GoogleCloudIncident[]): string {
  if (incidents.length === 0) {
    return "所有系统正常运行";
  }

  const numbers = incidents
    .map((incident) => incident.number)
    .filter((value): value is string | number => value !== null && value !== undefined)
    .slice(0, 3)
    .map(String);
  const suffix = incidents.length > 3 ? "..." : "";

  return numbers.length > 0
    ? `Google Cloud 报告 ${GEMINI_PRODUCT_TITLE} 事件: ${numbers.join(", ")}${suffix}`
    : `Google Cloud 报告 ${GEMINI_PRODUCT_TITLE} 存在进行中的事件`;
}

/**
 * 检查 Gemini 官方服务状态（通过 Google Cloud Status）
 */
export async function checkGeminiStatus(): Promise<OfficialStatusResult> {
  const checkedAt = new Date().toISOString();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(GOOGLE_CLOUD_INCIDENTS_URL, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        status: "unknown",
        message: `HTTP ${response.status}`,
        checkedAt,
      };
    }

    const data = (await response.json()) as unknown;
    const incidents = Array.isArray(data) ? (data as GoogleCloudIncident[]) : [];
    const activeGeminiIncidents = incidents
      .filter(isGeminiRelatedIncident)
      .filter(isActiveIncident);

    if (activeGeminiIncidents.length === 0) {
      return {
        status: "operational",
        message: "所有系统正常运行",
        checkedAt,
      };
    }

    return {
      status: toStatus(activeGeminiIncidents),
      message: formatMessage(activeGeminiIncidents),
      checkedAt,
      affectedComponents: [GEMINI_PRODUCT_TITLE],
    };
  } catch (error) {
    logError("checkGeminiStatus", error);

    if ((error as Error).name === "AbortError") {
      return {
        status: "unknown",
        message: "检查超时",
        checkedAt,
      };
    }

    return {
      status: "unknown",
      message: "检查失败",
      checkedAt,
    };
  }
}

