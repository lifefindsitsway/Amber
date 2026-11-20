import type { LlmProtocol } from "./enums.ts";

/**
 * Built-in LLM Profile presets: which protocols a vendor serves and where, never model
 * capability facts, so every model a user adds starts with all flags `unknown`. The list order
 * is the order the add dialog shows. A preset only fills the form and picks the icon: it never
 * widens an address, auth or outbound-network rule, and request parameters never depend on it.
 *
 * The address is the single source of truth. A region or workspace id is never stored; it is
 * read back from the Base URL by exact match (`matchPresetAddress`), and an address that matches
 * nothing is shown as a custom address.
 */

export const LLM_PRESET_IDS = ["deepseek", "qwen", "kimi", "glm", "openai", "anthropic", "gemini", "grok", "custom"] as const;
export type LlmPresetId = (typeof LLM_PRESET_IDS)[number];

export const CUSTOM_PRESET_ID: LlmPresetId = "custom";

/** One protocol a region serves; `legacy` marks an endpoint the vendor keeps only for old clients. */
export interface LlmPresetEndpoint {
  protocol: LlmProtocol;
  /** The vendor's general address; absent where the region is reachable only through a workspace host. */
  baseURL?: string;
  legacy?: true;
}

export interface LlmPresetRegion {
  /** Stable id; its display name comes from the i18n resources. */
  id: string;
  /** Protocols served here, the first being the default. */
  endpoints: readonly LlmPresetEndpoint[];
  /**
   * Host suffix of the vendor's dedicated per-workspace address, which becomes
   * `https://<workspaceId>.<workspaceHost><workspacePath>`.
   */
  workspaceHost?: string;
}

export interface LlmPreset {
  id: LlmPresetId;
  /** The first region is the default; presets without regions have exactly one, `"default"`. */
  regions: readonly LlmPresetRegion[];
  /** Path appended to a workspace host; set when any region has `workspaceHost`. */
  workspacePath?: string;
}

const SINGLE_REGION = "default";

const QWEN_PATH = "/compatible-mode/v1";

export const LLM_PRESETS: readonly LlmPreset[] = [
  {
    id: "deepseek",
    regions: [
      {
        id: SINGLE_REGION,
        endpoints: [
          { protocol: "openai_compatible", baseURL: "https://api.deepseek.com" },
          { protocol: "anthropic_messages", baseURL: "https://api.deepseek.com/anthropic" },
        ],
      },
    ],
  },
  {
    id: "qwen",
    workspacePath: QWEN_PATH,
    regions: [
      { id: "cn-beijing", endpoints: [{ protocol: "openai_compatible", baseURL: `https://dashscope.aliyuncs.com${QWEN_PATH}` }], workspaceHost: "cn-beijing.maas.aliyuncs.com" },
      { id: "ap-southeast-1", endpoints: [{ protocol: "openai_compatible", baseURL: `https://dashscope-intl.aliyuncs.com${QWEN_PATH}` }], workspaceHost: "ap-southeast-1.maas.aliyuncs.com" },
      { id: "cn-hongkong", endpoints: [{ protocol: "openai_compatible", baseURL: `https://cn-hongkong.dashscope.aliyuncs.com${QWEN_PATH}` }], workspaceHost: "cn-hongkong.maas.aliyuncs.com" },
      { id: "us-east-1", endpoints: [{ protocol: "openai_compatible", baseURL: `https://dashscope-us.aliyuncs.com${QWEN_PATH}` }], workspaceHost: "us-east-1.maas.aliyuncs.com" },
      { id: "ap-northeast-1", endpoints: [{ protocol: "openai_compatible" }], workspaceHost: "ap-northeast-1.maas.aliyuncs.com" },
      { id: "eu-central-1", endpoints: [{ protocol: "openai_compatible" }], workspaceHost: "eu-central-1.maas.aliyuncs.com" },
    ],
  },
  {
    id: "kimi",
    regions: [
      { id: "cn", endpoints: [{ protocol: "openai_compatible", baseURL: "https://api.moonshot.cn/v1" }] },
      { id: "intl", endpoints: [{ protocol: "openai_compatible", baseURL: "https://api.moonshot.ai/v1" }] },
    ],
  },
  {
    id: "glm",
    regions: [
      { id: "cn", endpoints: [{ protocol: "openai_compatible", baseURL: "https://open.bigmodel.cn/api/paas/v4" }] },
      { id: "intl", endpoints: [{ protocol: "openai_compatible", baseURL: "https://api.z.ai/api/paas/v4" }] },
    ],
  },
  {
    id: "openai",
    regions: [
      {
        id: SINGLE_REGION,
        endpoints: [
          { protocol: "openai_compatible", baseURL: "https://api.openai.com/v1" },
          { protocol: "openai_responses", baseURL: "https://api.openai.com/v1" },
        ],
      },
    ],
  },
  { id: "anthropic", regions: [{ id: SINGLE_REGION, endpoints: [{ protocol: "anthropic_messages", baseURL: "https://api.anthropic.com" }] }] },
  { id: "gemini", regions: [{ id: SINGLE_REGION, endpoints: [{ protocol: "openai_compatible", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" }] }] },
  {
    id: "grok",
    regions: [
      {
        id: SINGLE_REGION,
        endpoints: [
          { protocol: "openai_responses", baseURL: "https://api.x.ai/v1" },
          { protocol: "openai_compatible", baseURL: "https://api.x.ai/v1", legacy: true },
        ],
      },
    ],
  },
  { id: "custom", regions: [] },
];

export function isLlmPresetId(value: string): value is LlmPresetId {
  return (LLM_PRESET_IDS as readonly string[]).includes(value);
}

export function presetById(id: string | undefined): LlmPreset | undefined {
  return id === undefined ? undefined : LLM_PRESETS.find((preset) => preset.id === id);
}

/** Whether the preset lets the user choose among regions (more than one). */
export function hasRegions(preset: LlmPreset): boolean {
  return preset.regions.length > 1;
}

/** Whether any region of the preset offers a dedicated workspace address. */
export function supportsWorkspace(preset: LlmPreset): boolean {
  return preset.workspacePath !== undefined && preset.regions.some((region) => region.workspaceHost !== undefined);
}

/** Protocols the preset serves, the default first; empty for the custom preset (all protocols allowed). */
export function presetProtocols(preset: LlmPreset): readonly LlmPresetEndpoint[] {
  return preset.regions[0]?.endpoints ?? [];
}

/** A workspace id is one DNS label, compared in lower case. */
const WORKSPACE_ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeWorkspaceId(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidWorkspaceId(id: string): boolean {
  return WORKSPACE_ID.test(id);
}

export interface PresetAddressChoice {
  regionId?: string;
  protocol: LlmProtocol;
  /** Already normalized; when present the dedicated workspace address is used. */
  workspaceId?: string;
}

/**
 * The vendor's official Base URL for a choice, or `undefined` when there is none: an unknown
 * region or protocol, an invalid workspace id, or a region reachable only through a workspace
 * address while no workspace id is given.
 */
export function officialBaseUrl(preset: LlmPreset, choice: PresetAddressChoice): string | undefined {
  const region = choice.regionId === undefined ? preset.regions[0] : preset.regions.find((item) => item.id === choice.regionId);
  const endpoint = region?.endpoints.find((item) => item.protocol === choice.protocol);
  if (region === undefined || endpoint === undefined) {
    return undefined;
  }
  if (choice.workspaceId !== undefined && choice.workspaceId !== "") {
    if (region.workspaceHost === undefined || preset.workspacePath === undefined || !isValidWorkspaceId(choice.workspaceId)) {
      return undefined;
    }
    return `https://${choice.workspaceId}.${region.workspaceHost}${preset.workspacePath}`;
  }
  return endpoint.baseURL;
}

export interface PresetAddressMatch {
  regionId: string;
  workspaceId?: string;
}

/** Trailing slashes off and the scheme and host lower-cased, as Base URLs are compared. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*)(.*)$/.exec(trimmed);
  return match === null ? trimmed : `${(match[1] ?? "").toLowerCase()}${match[2] ?? ""}`;
}

/**
 * Reads the region (and workspace id) back from a Base URL by exact match against the preset's
 * official addresses for `protocol`. `undefined` means a custom address.
 */
export function matchPresetAddress(preset: LlmPreset, protocol: LlmProtocol, baseURL: string): PresetAddressMatch | undefined {
  const url = normalizeBaseUrl(baseURL);
  for (const region of preset.regions) {
    const endpoint = region.endpoints.find((item) => item.protocol === protocol);
    if (endpoint === undefined) {
      continue;
    }
    if (endpoint.baseURL !== undefined && normalizeBaseUrl(endpoint.baseURL) === url) {
      return { regionId: region.id };
    }
    if (region.workspaceHost !== undefined && preset.workspacePath !== undefined) {
      const prefix = "https://";
      const suffix = `.${region.workspaceHost}${preset.workspacePath}`;
      if (url.startsWith(prefix) && url.endsWith(suffix)) {
        const workspaceId = url.slice(prefix.length, url.length - suffix.length);
        if (isValidWorkspaceId(workspaceId)) {
          return { regionId: region.id, workspaceId };
        }
      }
    }
  }
  return undefined;
}

/** Interface paths users sometimes paste at the end of a Base URL by mistake. */
const ENDPOINT_PATH_SUFFIXES = ["/chat/completions", "/responses", "/messages"] as const;

/** The interface path a Base URL wrongly ends with, if any. */
export function endpointPathSuffix(baseURL: string): string | undefined {
  const url = normalizeBaseUrl(baseURL).toLowerCase();
  return ENDPOINT_PATH_SUFFIXES.find((suffix) => url.endsWith(suffix));
}
