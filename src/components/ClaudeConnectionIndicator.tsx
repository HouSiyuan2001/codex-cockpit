import { Plugs, SpinnerGap } from "@phosphor-icons/react";
import { useId } from "react";
import type { useSharedClaudeQuota } from "../hooks/useClaudeUsage";
import { formatDateTime } from "../lib/format";
import type { Language } from "../types";

export function ClaudeConnectionIndicator({ language, message, shared, login, onLogin }: {
  language: Language;
  message: string;
  shared?: ReturnType<typeof useSharedClaudeQuota>;
  login?: { pending: boolean; error: string | null };
  onLogin?: () => void;
}) {
  const tooltipId = useId();
  const english = language === "en";
  const source = shared?.snapshot;
  const syncStatus = source
    ? (english ? `Synced from ${source.deviceName}` : `同步自 ${source.deviceName}`)
    : shared?.status === "disconnected"
      ? (english ? "This device has not joined a sync space." : "本机尚未加入同步空间")
      : shared?.status === "error"
        ? (english ? "Could not read synced quota." : "暂时无法读取同步额度")
        : shared?.status === "ready"
          ? (english ? "No synced Claude quota yet." : "共享空间暂无 Claude 额度")
          : (english ? "Checking synced quota…" : "正在读取同步额度…");
  const loginStatus = login?.pending
    ? (english ? "Waiting for sign-in…" : "等待登录…")
    : login?.error === "cli_missing"
      ? (english ? "Claude Code CLI not found." : "未找到 Claude Code 命令行")
      : login?.error === "auth_busy"
        ? (english ? "Claude Code is already signing in." : "Claude Code 正在更新登录")
        : login?.error
          ? (english ? "Sign-in incomplete. Try again or run claude auth login." : "登录未完成。请重试，或运行 claude auth login")
          : onLogin ? (english ? "Click to sign in again." : "点击重新登录") : null;

  return (
    <span className="claude-connection">
      <button type="button" className="claude-connection-button" aria-label={message} aria-describedby={tooltipId}
        aria-disabled={login?.pending || undefined} onMouseDown={event => event.stopPropagation()}
        onClick={() => {
          if (!login?.pending) (onLogin ?? shared?.refresh)?.();
        }}>
        {login?.pending ? <SpinnerGap aria-hidden="true" /> : <Plugs weight="bold" aria-hidden="true" />}
      </button>
      <span className="claude-connection-tooltip" id={tooltipId} role="tooltip">
        <strong>{message}</strong>
        <span>{syncStatus}</span>
        {source && <time dateTime={source.quota.observedAt}>{formatDateTime(source.quota.observedAt, language)}</time>}
        {loginStatus && <span>{loginStatus}</span>}
      </span>
    </span>
  );
}
