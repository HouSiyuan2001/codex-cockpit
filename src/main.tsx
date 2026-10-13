import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DesignPlayground } from "./components/DesignPlayground";
import "./styles.css";

document.documentElement.dataset.platform = /Windows/i.test(navigator.userAgent)
  ? "windows"
  : /Macintosh|Mac OS X/i.test(navigator.userAgent) ? "macos" : /Linux/i.test(navigator.userAgent) ? "linux" : "other";

function BrowserPreview() {
  return (
    <div className="browser-preview-shell">
      <div className="browser-widget-frame"><App /></div>
      <p className="browser-preview-note">Click to expand · synthetic quota / Watch preview</p>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("designer") || params.has("preview")) return <DesignPlayground />;
    return "__TAURI_INTERNALS__" in window ? <App /> : <BrowserPreview />;
  })()}</React.StrictMode>,
);
