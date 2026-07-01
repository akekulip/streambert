import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";
import { installWebShim } from "./web/electron-shim";

// In a browser (no Electron preload), install the web shim so window.electron
// exists and the existing UI's isElectron paths work against the backend.
installWebShim();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
