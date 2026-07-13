const WS_URL = process.env.XIAOWEI_API_URL || "ws://127.0.0.1:22222/";

function send(request, timeoutMs = 8000) {
  if (typeof WebSocket !== "function") {
    throw new Error("This optional Xiaowei probe requires a Node runtime with WebSocket support");
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Xiaowei API probe timed out"));
    }, timeoutMs);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ action: "list" })));
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      socket.close();
      try { resolve(JSON.parse(String(event.data))); } catch { resolve(String(event.data)); }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Unable to connect to the optional Xiaowei API probe"));
    });
  });
}

async function main() {
  const command = process.argv[2] || "help";
  if (command === "help") {
    process.stdout.write("node scripts/xiaowei-api.mjs list\nOnly the read-only capability probe is enabled. Device actions remain disabled until formal per-action validation.\n");
    return;
  }
  if (command !== "list") {
    throw new Error("Xiaowei API device actions are disabled; use the verified ADB read-only provider");
  }
  const result = await send({ action: "list" });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
