import React from "react";
import { createRoot } from "react-dom/client";
import { t } from "@oncare/web-common";
import { App } from "./App";
import "./styles.css";

document.title = t("family.document_title");
createRoot(document.getElementById("root")!).render(<React.StrictMode><App apiBase={import.meta.env.VITE_API_BASE ?? "/api"} /></React.StrictMode>);
