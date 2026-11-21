import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiClient, resolveEndpoint } from "./api/client.ts";
import { ApiProvider, createQueryClient } from "./api/context.tsx";
import { App } from "./app.tsx";
import { markDesktopShell } from "./desktop/bridge.ts";
import { initI18n } from "./i18n.ts";
import { applyTheme } from "./shell/theme.ts";
import { TooltipProvider } from "./ui/tooltip.tsx";
import "./styles.css";

async function start(): Promise<void> {
  initI18n();
  applyTheme(undefined);
  void markDesktopShell();
  const root = document.getElementById("root");
  if (root === null) {
    throw new Error("#root missing");
  }
  const client = await new ApiClient(await resolveEndpoint()).init();
  createRoot(root).render(
    <StrictMode>
      <ApiProvider client={client} queryClient={createQueryClient()}>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </ApiProvider>
    </StrictMode>,
  );
}

void start();
