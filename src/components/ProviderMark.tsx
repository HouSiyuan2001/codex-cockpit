import type { CSSProperties } from "react";
import codexLogo from "../../codex.svg";
import antigravityLogo from "../assets/providers/antigravity.svg";
import qoderLogo from "../assets/providers/qoder.svg";
import traeLogo from "../assets/providers/trae.svg";
import volcengineLogo from "../assets/providers/volcengine.svg";
import workbuddyLogo from "../assets/providers/workbuddy.svg";

const providerLogos: Record<string, string> = {
  codex: codexLogo,
  qoder: qoderLogo,
  trae: traeLogo,
  workbuddy: workbuddyLogo,
  volcengine: volcengineLogo,
  antigravity: antigravityLogo,
};

export function ProviderMark({ provider = "codex", label = "Codex" }: { provider?: string; label?: string }) {
  const logo = providerLogos[provider];
  return (
    <div className="provider-mark" data-provider={provider} aria-label={label}>
      {logo ? (
        <span
          className="provider-mark-glyph"
          style={{ "--provider-logo": `url("${logo}")` } as CSSProperties}
          aria-hidden="true"
        />
      ) : <strong aria-hidden="true">{label.slice(0, 1)}</strong>}
    </div>
  );
}
