import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import WindowTitleBar from "./components/WindowTitleBar";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WindowTitleBar />
    <div className="app-viewport">
      <App />
    </div>
  </React.StrictMode>,
);
