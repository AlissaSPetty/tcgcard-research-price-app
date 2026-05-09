import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import App from "./App";
import { PersistHydrationGate } from "./PersistHydrationGate";
import { initThemeFromStorage } from "./theme";
import { queryClient, queryPersister } from "./queryClient";
import "./styles.css";

initThemeFromStorage();

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister: queryPersister, maxAge: 1000 * 60 * 60 * 24 }}
      >
        <PersistHydrationGate>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </PersistHydrationGate>
      </PersistQueryClientProvider>
    </StrictMode>,
  );
}
