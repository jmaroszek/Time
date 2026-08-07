import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "../src/index.css";
import "./visual.css";
import App from "../src/App";
import WindowTitleBar from "../src/components/WindowTitleBar";
import { LAST_UPDATE_CHECK_KEY } from "../src/lib/appUpdate";

// The update check debounces itself for a day through localStorage, which
// outlives a page load. Every fixture load has to be the first one, or the
// second spec to open the same context would find the control gone.
window.localStorage.removeItem(LAST_UPDATE_CHECK_KEY);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WindowTitleBar />
    <div className="app-viewport">
      <App />
    </div>
  </React.StrictMode>,
);
