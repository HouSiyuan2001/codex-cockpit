import type { ProviderId } from "../types";

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  sourceLabel: {
    en: string;
    "zh-CN": string;
  };
}

export const PROVIDER_CATALOG: readonly ProviderDefinition[] = [
  { id: "codex", label: "CODEX", sourceLabel: { en: "Codex local session", "zh-CN": "Codex 本地登录态" } },
  { id: "qoder", label: "QODER", sourceLabel: { en: "Qoder account cache", "zh-CN": "Qoder 本地账户缓存" } },
  { id: "trae", label: "TRAE", sourceLabel: { en: "TRAE local session", "zh-CN": "TRAE 本地登录态" } },
  { id: "workbuddy", label: "WORKBUDDY", sourceLabel: { en: "WorkBuddy local session", "zh-CN": "WorkBuddy 本地登录态" } },
  { id: "volcengine", label: "VOLCENGINE", sourceLabel: { en: "Ark CLI profile", "zh-CN": "Ark CLI 本地配置" } },
  { id: "antigravity", label: "ANTIGRAVITY", sourceLabel: { en: "Antigravity local quota service", "zh-CN": "Antigravity 本地额度服务" } },
];

export const DEFAULT_PROVIDER_ORDER: ProviderId[] = PROVIDER_CATALOG.map((provider) => provider.id);

export function normalizeProviderOrder(order?: readonly ProviderId[] | null): ProviderId[] {
  const valid = new Set(DEFAULT_PROVIDER_ORDER);
  const normalized: ProviderId[] = [];
  for (const provider of order ?? []) {
    if (valid.has(provider) && !normalized.includes(provider)) normalized.push(provider);
  }
  for (const provider of DEFAULT_PROVIDER_ORDER) {
    if (!normalized.includes(provider)) normalized.push(provider);
  }
  return normalized;
}
