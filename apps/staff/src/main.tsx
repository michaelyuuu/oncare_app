import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
createRoot(document.getElementById("root")!).render(<App apiBase={import.meta.env.VITE_API_BASE ?? "/api"}/>);
