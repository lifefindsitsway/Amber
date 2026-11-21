import { createContext, useContext, useMemo, type ReactNode } from "react";
import { decodeModelKey } from "../../../shared/dto/usage-analytics.ts";
import { useAsrProfiles, useProviders } from "../../api/queries.ts";
import { AsrServiceMark, LlmModelMark } from "../../models/model-mark.tsx";

/**
 * What the page knows of the owner's current profiles, for marks only: an LLM profile's service
 * preset and a transcription profile's service, by profile id. A profile missing here (deleted,
 * or the lists failed to load) still gets a mark: an LLM by its model name, else the neutral glyph.
 */
interface ProfileServices {
  llmPresets: ReadonlyMap<string, string | undefined>;
  asrProviders: ReadonlyMap<string, string>;
}

const EMPTY: ProfileServices = { llmPresets: new Map(), asrProviders: new Map() };

const ServicesContext = createContext<ProfileServices>(EMPTY);

/** Loads the profile lists once for the page; the marks never wait for them and never change a number. */
export function UsageMarksProvider(props: { children: ReactNode }) {
  const providers = useProviders();
  const asrProfiles = useAsrProfiles();
  const llmItems = providers.data?.items;
  const asrItems = asrProfiles.data?.items;
  const value = useMemo<ProfileServices>(
    () => ({
      llmPresets: new Map((llmItems ?? []).map((profile) => [profile.id, profile.presetId])),
      asrProviders: new Map((asrItems ?? []).map((profile) => [profile.id, profile.provider])),
    }),
    [llmItems, asrItems],
  );
  return <ServicesContext.Provider value={value}>{props.children}</ServicesContext.Provider>;
}

/** The mark of a usage model, by its opaque key and its id; decorative, beside the written name. */
export function UsageModelMark(props: { modelKey: string; modelId: string; size: number; className?: string }) {
  const services = useContext(ServicesContext);
  const parts = decodeModelKey(props.modelKey);
  const className = props.className ?? "";
  if (parts?.[0] === "asr") return <AsrServiceMark provider={services.asrProviders.get(parts[1])} size={props.size} className={className} />;
  const presetId = parts === undefined ? undefined : services.llmPresets.get(parts[1]);
  return <LlmModelMark modelId={props.modelId} presetId={presetId} size={props.size} className={className} />;
}
