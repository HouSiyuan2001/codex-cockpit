import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DesignPlayground } from "./components/DesignPlayground";
import "./styles.css";

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
