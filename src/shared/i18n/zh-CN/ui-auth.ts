/** UI copy of the server-mode login, setup and password pages; keys are dot paths under `auth`. */
export const auth = {
  login: {
    title: "Amber - AI 音视频处理",
    username: "用户名",
    password: "密码",
    submit: "登录",
    rateLimited: "尝试过于频繁，请 {{seconds}} 秒后再试",
    rateLimitedNoDelay: "尝试过于频繁，请稍后再试",
    setupLink: "首次部署？初始化管理员",
  },
  changePassword: {
    title: "设置新密码",
    /** Shown whenever the password was set by someone else: a new account, an admin reset or a preset first admin. */
    intro: "你正在使用临时密码。为了账号安全，请先设置一个只有你自己知道的新密码。",
    currentPassword: "当前密码",
    newPassword: "新密码",
    confirmPassword: "确认新密码",
    submit: "保存新密码",
    tooShort: "新密码至少 {{min}} 个字符",
    mismatch: "两次输入的新密码不一致",
    wrongCurrent: "当前密码不正确",
  },
  passwordPage: {
    title: "修改密码",
    account: "当前账号",
    roleValue: {
      admin: "管理员",
      user: "普通用户",
    },
    submit: "修改密码",
    changed: "密码已修改，其它设备上的登录已退出",
  },
  passwordInput: {
    show: "显示密码",
  },
  setup: {
    title: "初始化管理员",
    intro: "这是一台尚未初始化的 Amber 服务器。请输入服务器启动时打印在控制台的一次性 setup token，并创建第一个管理员账号。",
    token: "Setup token",
    tokenHint: "只在服务器控制台输出中可见；用一次即失效，过期需重启服务器获取新 token。",
    username: "用户名",
    usernameHint: "3–32 个字符，可用小写字母、数字、点、下划线与连字符",
    password: "密码",
    confirmPassword: "确认密码",
    displayName: "显示名（可选）",
    submit: "创建管理员",
    badToken: "setup token 无效或已过期。过期的 token 需重启服务器后从控制台取新的。",
    alreadyInitialized: "这台服务器已经初始化过了。",
    goLogin: "去登录",
    backToLogin: "返回登录",
  },
} as const;
