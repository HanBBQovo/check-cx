import { appendHistory } from "@/lib/history-store";
import { runProviderChecks, type HealthStatus } from "@/lib/checks";
import { getPollingIntervalMs } from "@/lib/polling-config";

const POLL_INTERVAL_MS = getPollingIntervalMs();

const globalWithPoller = globalThis as typeof globalThis & {
  __checkCxPoller?: NodeJS.Timeout;
  __checkCxPollerRunning?: boolean;
  __checkCxLastPingStartedAt?: number;
};

async function tick() {
  if (globalWithPoller.__checkCxPollerRunning) {
    const lastStartedAt = globalWithPoller.__checkCxLastPingStartedAt;
    const duration = lastStartedAt ? Date.now() - lastStartedAt : null;
    console.log(
      `[check-cx] 跳过 ping：上一轮仍在执行${
        duration !== null ? `（已耗时 ${duration}ms）` : ""
      }`
    );
    return;
  }

  const startedAt = Date.now();
  globalWithPoller.__checkCxLastPingStartedAt = startedAt;
  console.log(
    `[check-cx] 后台 ping 开始 · ${new Date(
      startedAt
    ).toISOString()} · interval=${POLL_INTERVAL_MS}ms`
  );

  globalWithPoller.__checkCxPollerRunning = true;
  try {
    const results = await runProviderChecks();
    if (results.length === 0) {
      const groups = process.env.CHECK_GROUPS ?? "";
      console.log(
        `[check-cx] 未检测到任何有效配置，CHECK_GROUPS="${groups}"，本轮 ping 结束`
      );
      return;
    }

    console.log("[check-cx] 本轮检测明细：");
    results.forEach((result) => {
      const latency =
        typeof result.latencyMs === "number" ? `${result.latencyMs}ms` : "N/A";
      const sanitizedMessage = (result.message || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      console.log(
        `[check-cx]   · ${result.name}(${result.type}/${result.model}) -> ${
          result.status
        } | latency=${latency} | endpoint=${result.endpoint} | message=${
          sanitizedMessage || "无"
        }`
      );
    });

    console.log(
      `[check-cx] 正在写入历史记录（${results.length} 条）…`
    );
    const historySnapshot = await appendHistory(results);
    const providerCount = Object.keys(historySnapshot).length;
    const recordCount = Object.values(historySnapshot).reduce(
      (total, items) => total + items.length,
      0
    );
    console.log(
      `[check-cx] 历史记录更新完成：providers=${providerCount}，总记录=${recordCount}`
    );

    const statusCounts: Record<HealthStatus, number> = {
      operational: 0,
      degraded: 0,
      failed: 0,
    };
    results.forEach((result) => {
      statusCounts[result.status] += 1;
    });

    const elapsed = Date.now() - startedAt;
    const nextSchedule = new Date(startedAt + POLL_INTERVAL_MS).toISOString();

    console.log(
      `[check-cx] 本轮 ping 完成，用时 ${elapsed}ms；operational=${
        statusCounts.operational
      } degraded=${statusCounts.degraded} failed=${
        statusCounts.failed
      }。下次预计 ${nextSchedule}`
    );
  } catch (error) {
    console.error("[check-cx] 轮询检测失败", error);
  } finally {
    globalWithPoller.__checkCxPollerRunning = false;
  }
}

if (!globalWithPoller.__checkCxPoller) {
  console.log(
    `[check-cx] 初始化后台轮询器，interval=${POLL_INTERVAL_MS}ms`
  );
  tick().catch((error) => console.error("[check-cx] 初次检测失败", error));
  globalWithPoller.__checkCxPoller = setInterval(() => {
    tick().catch((error) => console.error("[check-cx] 定时检测失败", error));
  }, POLL_INTERVAL_MS);
}
