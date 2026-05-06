import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { initThemeFromStorage } from "./theme";
import "./styles.css";

initThemeFromStorage();

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}
