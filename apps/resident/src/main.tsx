import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { t } from "@oncare/web-common";
import "./styles.css";
document.title = t("app.title");
createRoot(document.getElementById("root")!).render(<React.StrictMode><App apiBase={import.meta.env.VITE_API_BASE ?? "/api"}/></React.StrictMode>);
