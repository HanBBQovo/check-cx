/**
 * 官方状态检查器统一入口
 * 根据 Provider 类型调用对应的状态检查函数
 */

import type {OfficialStatusResult, ProviderType} from "../types";
import {checkOpenAIStatus} from "./openai";
import {checkAnthropicStatus} from "./anthropic";
import {checkGeminiStatus} from "./gemini";

/**
 * 检查指定 Provider 的官方服务状态
 * @param type - Provider 类型
 * @returns 官方状态检查结果
 */
export async function checkOfficialStatus(
  type: ProviderType
): Promise<OfficialStatusResult> {
  const checkedAt = new Date().toISOString();

  switch (type) {
    case "openai":
      return checkOpenAIStatus();

    case "gemini":
      return checkGeminiStatus();

    case "anthropic":
      return checkAnthropicStatus();

    default:
      return {
        status: "unknown",
        message: "不支持的 Provider 类型",
        checkedAt,
      };
  }
}

/**
 * 批量检查所有 Provider 的官方状态
 * @param types - Provider 类型列表
 * @returns Provider 类型到状态结果的映射
 */
export async function checkAllOfficialStatuses(
  types: ProviderType[]
): Promise<Map<ProviderType, OfficialStatusResult>> {
  const results = await Promise.all(
    types.map(async (type) => {
      const result = await checkOfficialStatus(type);
      return [type, result] as const;
    })
  );

  return new Map(results);
}
