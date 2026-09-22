import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const urls = {
  resident: import.meta.env.VITE_RESIDENT_URL ?? "http://localhost:5173/",
  family: import.meta.env.VITE_FAMILY_URL ?? "http://localhost:5174/",
  staff: import.meta.env.VITE_STAFF_URL ?? "http://localhost:5175/",
};

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App demo={import.meta.env.VITE_ONCARE_DEMO === "1"} urls={urls} />
  </React.StrictMode>,
);
