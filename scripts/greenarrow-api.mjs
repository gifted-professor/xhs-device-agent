import { pathToFileURL } from "node:url";

import { XiaoweiClient } from "./lib/xiaowei-client.mjs";
import { XiaoweiTransport } from "./lib/xiaowei-transport.mjs";

const DEFAULT_DEVICE = "";

export function createLegacyClient({ transport = new XiaoweiTransport({ requestTimeoutMs: 8000 }) } = {}) {
  return new XiaoweiClient({
    transport,
    // Compatibility only: LVJIAN_DEVICE already contains the runtime identifier.
    resolveDevice: async (legacyDevice) => ({ identifier: legacyDevice }),
  });
}

function vendorResponse(result) {
  return result?.vendorResponse ?? result;
}

async function legacyCall(action, invoke) {
  try {
    return await invoke();
  } catch (error) {
    if (error?.code === "XIAOWEI_VENDOR_ERROR" && error?.details?.response !== undefined) {
      return error.details.response;
    }
    if (error?.code === "XIAOWEI_TIMEOUT") throw new Error(`绿箭 API 超时：${action}`);
    if (error?.code === "XIAOWEI_CONNECTION_ERROR" || error?.code === "XIAOWEI_WEBSOCKET_UNAVAILABLE") {
      throw new Error("无法连接绿箭 API，请确认绿箭矩阵正在运行且 API 服务已开启");
    }
    throw error;
  }
}

export async function executeLegacyCommand(argv, {
  env = process.env,
  client = createLegacyClient(),
} = {}) {
  const [command = "help", ...args] = argv;
  const device = env.LVJIAN_DEVICE || DEFAULT_DEVICE;
  if (!device && !["help", "list"].includes(command)) {
    throw new Error("请先设置环境变量 LVJIAN_DEVICE");
  }

  switch (command) {
    case "list":
      return legacyCall("list", () => client.deviceList());

    case "home":
      return vendorResponse(await legacyCall("pushEvent", () => client.home({ deviceAlias: device })));

    case "back":
      return vendorResponse(await legacyCall("pushEvent", () => client.back({ deviceAlias: device })));

    case "start-xhs":
      return legacyCall("startApk", () => client.targeted(device, "startApk", { apk: "com.xingin.xhs" }));

    case "tap-xhs":
      throw new Error("不同手机桌面布局不同，请使用 start-xhs 按包名启动，或先读取页面结构再点击");

    case "tap": {
      if (args.length < 2) throw new Error("用法：tap <x百分比> <y百分比>");
      const [x, y] = args;
      const down = await legacyCall("pointerEvent", () => client.targeted(device, "pointerEvent", { type: "0", x, y }));
      const up = await legacyCall("pointerEvent", () => client.targeted(device, "pointerEvent", { type: "1", x, y }));
      return { down, up, percent: { x, y } };
    }

    case "swipe-up":
      return vendorResponse(await legacyCall("pointerEvent", () => client.swipe({ deviceAlias: device, direction: "up" })));

    case "swipe-down":
      return vendorResponse(await legacyCall("pointerEvent", () => client.swipe({ deviceAlias: device, direction: "down" })));

    case "screenshot":
      return legacyCall("Screen", () => client.targeted(device, "Screen", { savePath: args[0] || "D:\\Pictures" }));

    case "shell":
      if (!args.length) throw new Error("用法：shell <adb shell 后面的命令>");
      return legacyCall("adb_shell", () => client.targeted(device, "adb_shell", { command: args.join(" ") }));

    case "help":
    default:
      return undefined;
  }
}

export function legacyHelp() {
  return `绿箭 API 控制器

node 绿箭API控制器.mjs list
node 绿箭API控制器.mjs home
node 绿箭API控制器.mjs back
node 绿箭API控制器.mjs start-xhs
node 绿箭API控制器.mjs tap-xhs
node 绿箭API控制器.mjs tap <x百分比> <y百分比>
node 绿箭API控制器.mjs swipe-up
node 绿箭API控制器.mjs swipe-down
node 绿箭API控制器.mjs screenshot [保存目录]
node 绿箭API控制器.mjs shell <adb shell 后面的命令>

必须通过环境变量 LVJIAN_DEVICE 指定设备串号。
新 Agent 接入建议使用 xhs.cmd 与 /device/v1/*，旧命令保持兼容。`;
}

export async function runLegacyCli(argv = process.argv.slice(2), {
  env = process.env,
  client = createLegacyClient(),
  io = console,
} = {}) {
  const result = await executeLegacyCommand(argv, { env, client });
  if (result === undefined) io.log(legacyHelp());
  else io.log(JSON.stringify(result, null, 2));
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  return runLegacyCli(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
