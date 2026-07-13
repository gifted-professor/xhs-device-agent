import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_SCRIPT_PATH = fileURLToPath(new URL("./windows-ocr.ps1", import.meta.url));

function compact(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function includesAny(text, values) {
  return values.some((value) => text.includes(value));
}

function defaultCommandRunner({ file, args, timeoutMs = 20_000 }) {
  return new Promise((resolve) => {
    execFile(file, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? (Number.isInteger(error.code) ? error.code : -1) : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
}

function parseOcrPayload(stdout) {
  const raw = String(stdout ?? "").replace(/^\uFEFF/u, "").trim();
  if (!raw) return null;
  const lines = raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === "object") return value;
    } catch { /* Ignore non-JSON host output and inspect the previous line. */ }
  }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Deterministically maps local OCR text to a conservative page hint.
 * It never returns coordinates or a device action.
 */
export function classifyLocalOcrText(value) {
  const text = compact(Array.isArray(value) ? value.join(" ") : value);
  if (!text) return null;

  const sensitive = includesAny(text, [
    "验证码", "安全验证", "身份验证", "登录", "注册", "扫码登录", "人机验证", "滑块验证",
    "支付", "付款", "收银台", "银行卡", "私信", "消息列表", "联系人", "通讯录", "风险提示",
    "权限申请", "系统权限", "应用权限", "允许访问", "始终允许", "仅在使用时允许", "不允许",
    "授权访问", "相机权限", "麦克风权限", "通知权限", "照片和视频", "位置权限",
    "我的订单", "订单详情", "交易详情", "收货地址", "账号与安全", "隐私设置", "实名认证",
  ]) || /(?:^|\D)1[3-9]\d{9}(?:\D|$)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:^|\D)\d{17}[\dXx](?:\D|$)/iu.test(text);
  if (sensitive) {
    return {
      pageType: "LOGIN_OR_CHALLENGE",
      confidence: 0.99,
      targetDescription: "",
      suggestedAction: "STOP_FOR_HUMAN",
      humanRequired: true,
      source: "windows_local_ocr",
    };
  }

  if (includesAny(text, ["网络异常", "网络错误", "连接失败", "加载失败"]) && includesAny(text, ["重试", "重新加载"])) {
    return {
      pageType: "NETWORK_ERROR",
      confidence: 0.95,
      targetDescription: "重试",
      suggestedAction: "RETRY",
      humanRequired: false,
      source: "windows_local_ocr",
    };
  }

  if (includesAny(text, ["版本更新", "发现新版本", "立即更新"]) && includesAny(text, ["以后再说", "暂不更新", "关闭", "取消"])) {
    return {
      pageType: "UPDATE_MODAL",
      confidence: 0.95,
      targetDescription: "关闭更新",
      suggestedAction: "DISMISS_UPDATE",
      humanRequired: false,
      source: "windows_local_ocr",
    };
  }

  if (text.includes("搜索") && includesAny(text, ["取消", "搜索发现", "历史搜索", "猜你想搜", "大家都在搜"])) {
    return {
      pageType: "SEARCH_ENTRY",
      confidence: 0.94,
      targetDescription: "搜索框",
      suggestedAction: "OPEN_SEARCH",
      humanRequired: false,
      source: "windows_local_ocr",
    };
  }

  if (text.includes("热搜") && includesAny(text, ["热搜榜", "热点", "大家都在搜", "实时上升"])) {
    return {
      pageType: "TRENDING",
      confidence: 0.93,
      targetDescription: "热搜入口",
      suggestedAction: "OPEN_TRENDING",
      humanRequired: false,
      source: "windows_local_ocr",
    };
  }

  if (text.includes("推荐") && includesAny(text, ["猜你喜欢", "为你推荐", "发现"])) {
    return {
      pageType: "RECOMMENDED",
      confidence: 0.92,
      targetDescription: "推荐入口",
      suggestedAction: "OPEN_RECOMMENDED",
      humanRequired: false,
      source: "windows_local_ocr",
    };
  }

  if (text.includes("首页") && includesAny(text, ["关注", "发现", "推荐"])) {
    return {
      pageType: "HOME_FEED",
      confidence: 0.92,
      targetDescription: "首页",
      suggestedAction: "OPEN_HOME",
      humanRequired: false,
      source: "windows_local_ocr",
    };
  }

  return null;
}

export function createWindowsLocalOcr(options = {}) {
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const scriptPath = options.scriptPath ?? DEFAULT_SCRIPT_PATH;
  const powershellPath = options.powershellPath ?? "powershell.exe";
  const enabled = options.enabled ?? process.platform === "win32";

  return async function windowsLocalOcr(input = {}) {
    if (!enabled || !input.imagePath) return null;
    let result;
    try {
      result = await commandRunner({
        file: powershellPath,
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ImagePath", input.imagePath],
        timeoutMs: 20_000,
      });
    } catch {
      return null;
    }
    if (Number(result?.exitCode) !== 0) return null;
    const payload = parseOcrPayload(result?.stdout);
    if (!payload || payload.available !== true) return null;
    const combinedText = [payload.text, ...(Array.isArray(payload.lines) ? payload.lines : [])].filter(Boolean).join(" ");
    if (!compact(combinedText)) return null;
    const classification = classifyLocalOcrText(combinedText);
    if (classification) {
      return {
        ...classification,
        ocrAvailable: true,
        safeForCloud: classification.humanRequired !== true,
      };
    }
    return {
      pageType: "UNKNOWN",
      confidence: 0,
      targetDescription: "",
      suggestedAction: "NONE",
      humanRequired: false,
      source: "windows_local_ocr",
      ocrAvailable: true,
      safeForCloud: true,
    };
  };
}
