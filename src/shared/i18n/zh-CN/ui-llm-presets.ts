/** Display names of the built-in LLM presets and their regions. */
export const llmPresets = {
  name: {
    deepseek: "DeepSeek",
    qwen: "Qwen（通义千问）",
    kimi: "Kimi（月之暗面）",
    glm: "GLM（智谱）",
    openai: "OpenAI",
    anthropic: "Anthropic",
    gemini: "Gemini",
    grok: "Grok（xAI）",
    custom: "自定义",
  },
  region: {
    qwen: {
      "cn-beijing": "中国（北京）",
      "ap-southeast-1": "新加坡",
      "cn-hongkong": "中国香港",
      "us-east-1": "美国（弗吉尼亚）",
      "ap-northeast-1": "日本（东京）",
      "eu-central-1": "德国（法兰克福）",
    },
    kimi: {
      cn: "中国",
      intl: "国际",
    },
    glm: {
      cn: "中国（智谱开放平台）",
      intl: "国际（Z.ai）",
    },
  },
} as const;
