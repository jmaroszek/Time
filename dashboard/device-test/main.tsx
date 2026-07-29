import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "../src/index.css";
import "./visual.css";
import App from "../src/App";
import WindowTitleBar from "../src/components/WindowTitleBar";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WindowTitleBar />
    <div className="app-viewport">
      <App />
    </div>
  </React.StrictMode>,
);
