import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ModelRefDto } from "../../../src/shared/dto/model-ref.ts";
import { modelReadiness, useModelReadiness, type ModelNeeds } from "../../../src/web/models/use-model-readiness.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";
import { provider } from "../../fixtures/web/shell-data.ts";
import { providerWithoutWindow } from "../../fixtures/web/context-window.ts";

const PROFILES = [provider("p1", "主力", ["known"]), providerWithoutWindow("p2", "备用", ["bare"])];
const KNOWN = { providerProfileId: "p1", modelId: "known" };
const BARE = { providerProfileId: "p2", modelId: "bare" };

function Probe(props: { modelRef: ModelRefDto | undefined; needs: ModelNeeds }) {
  const readiness = useModelReadiness(props.modelRef, props.needs);
  return (
    <p data-testid="probe" data-model={readiness.model?.modelId ?? ""} data-profile={readiness.profile?.name ?? ""}>
      {readiness.status}
    </p>
  );
}

describe("modelReadiness", () => {
  it("is no_model without a model, loading before the list arrives", () => {
    expect(modelReadiness(PROFILES, undefined, "context_window").status).toBe("no_model");
    expect(modelReadiness(undefined, KNOWN, "context_window").status).toBe("loading");
  });

  it("asks for the window only where it is needed and unknown", () => {
    expect(modelReadiness(PROFILES, KNOWN, "context_window").status).toBe("ready");
    expect(modelReadiness(PROFILES, BARE, "context_window")).toMatchObject({ status: "missing_context_window", model: { modelId: "bare" }, profile: { id: "p2" } });
    expect(modelReadiness(PROFILES, BARE, "none").status).toBe("ready");
  });

  it("leaves a model the list no longer has to the server", () => {
    expect(modelReadiness(PROFILES, { providerProfileId: "p2", modelId: "gone" }, "context_window")).toEqual({ status: "ready" });
  });
});

describe("useModelReadiness", () => {
  it("reads the provider list: loading, then missing, with the model it found", async () => {
    mockApi({ "GET /api/providers": { body: { items: PROFILES } } });
    renderApp(<Probe modelRef={BARE} needs="context_window" />);
    expect(screen.getByTestId("probe").textContent).toBe("loading");
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("missing_context_window"));
    expect(screen.getByTestId("probe").dataset["model"]).toBe("bare");
    expect(screen.getByTestId("probe").dataset["profile"]).toBe("备用");
  });

  it("is ready for a model with a window, and for any model when nothing needs one", async () => {
    mockApi({ "GET /api/providers": { body: { items: PROFILES } } });
    renderApp(
      <>
        <Probe modelRef={KNOWN} needs="context_window" />
        <Probe modelRef={BARE} needs="none" />
      </>,
    );
    await waitFor(() => expect(screen.getAllByTestId("probe").map((element) => element.textContent)).toEqual(["ready", "ready"]));
  });

  it("is no_model without a model, and does not block on a failed list read", async () => {
    mockApi({ "GET /api/providers": { status: 500, body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" } } } });
    renderApp(
      <>
        <Probe modelRef={undefined} needs="context_window" />
        <Probe modelRef={BARE} needs="context_window" />
      </>,
    );
    expect(screen.getAllByTestId("probe")[0]?.textContent).toBe("no_model");
    await waitFor(() => expect(screen.getAllByTestId("probe")[1]?.textContent).toBe("ready"), { timeout: 5000 });
  });
});
