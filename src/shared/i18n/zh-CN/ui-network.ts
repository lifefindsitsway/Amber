/** UI copy of the network status line in the model settings and the route tag of a connection test; keys are dot paths under `network`. */
export const network = {
  status: {
    label: "网络状态",
    systemManual: "网络：跟随 Windows 系统代理 · {{proxy}}",
    systemManualHttpOnly: "网络：跟随 Windows 系统代理（仅 HTTP）· {{proxy}}",
    systemManualHttpsOnly: "网络：跟随 Windows 系统代理（仅 HTTPS）· {{proxy}}",
    pacIgnored: "已忽略自动配置脚本",
    systemOff: "网络：直连（Windows 系统代理未开启）",
    pac: "网络：系统代理使用了自动配置脚本（PAC），Amber 暂不支持。请在代理软件中改用非 PAC 的系统代理模式",
    socks: "网络：系统代理只设置了 SOCKS，Amber 暂不支持。请在代理软件中开启 HTTP 系统代理",
    scheme: "网络：代理地址不是 http:// 开头，Amber 暂不支持",
    unparsable: "网络：无法识别系统代理的设置，Amber 不会改为直连",
    readFailed: "网络：暂时无法读取系统代理设置，沿用上次的设置",
    lastFailedSystem: "网络：最近一次连接系统代理失败（{{time}}），请确认代理软件正在运行",
    lastFailedServer: "网络：最近一次连接代理失败（{{time}}）",
    serverProxy: "网络：经代理",
    serverDirect: "网络：直连",
    proxyPair: "HTTP {{http}}，HTTPS {{https}}",
    withNote: "{{line}}（{{note}}）",
  },
  ago: {
    justNow: "刚刚",
    minutes: "{{n}} 分钟前",
    hours: "{{n}} 小时前",
    days: "{{n}} 天前",
  },
  route: {
    systemProxy: "经系统代理",
    proxy: "经代理",
    direct: "直连",
  },
} as const;
