import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import "./product-design.css";
import "./agent-form.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("DayCrew root element was not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
