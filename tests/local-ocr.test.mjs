import assert from "node:assert/strict";
import test from "node:test";

import { classifyLocalOcrText, createWindowsLocalOcr } from "../scripts/local-ocr.mjs";

test("local OCR classifier requires multiple page signals", () => {
  assert.equal(classifyLocalOcrText("搜索"), null);
  assert.deepEqual(classifyLocalOcrText("搜索 取消 历史搜索"), {
    pageType: "SEARCH_ENTRY",
    confidence: 0.94,
    targetDescription: "搜索框",
    suggestedAction: "OPEN_SEARCH",
    humanRequired: false,
    source: "windows_local_ocr",
  });
});

test("local OCR classifier stops on sensitive screens before ordinary classification", () => {
  const result = classifyLocalOcrText("首页 推荐 请输入验证码 登录");
  assert.equal(result.pageType, "LOGIN_OR_CHALLENGE");
  assert.equal(result.confidence, 0.99);
  assert.equal(result.humanRequired, true);
  assert.equal(result.suggestedAction, "STOP_FOR_HUMAN");
  assert.equal("x" in result || "y" in result || "bounds" in result, false);
});

test("Windows OCR adapter parses compact JSON and returns semantic hints only", async () => {
  let invocation;
  const localOcr = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async (input) => {
      invocation = input;
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ available: true, text: "网络异常 请重试", lines: ["重新加载"] })}\n`,
      };
    },
  });
  const result = await localOcr({ imagePath: "C:\\temp\\screen.png" });
  assert.equal(invocation.file, "powershell.exe");
  assert.equal(invocation.args.at(-1), "C:\\temp\\screen.png");
  assert.deepEqual(result, {
    pageType: "NETWORK_ERROR",
    confidence: 0.95,
    targetDescription: "重试",
    suggestedAction: "RETRY",
    humanRequired: false,
    source: "windows_local_ocr",
    ocrAvailable: true,
    safeForCloud: true,
  });
  assert.equal(JSON.stringify(result).includes("screen.png"), false);
});

test("Windows OCR adapter returns an explicit safe scan only when local OCR produced text", async () => {
  const readable = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async () => ({ exitCode: 0, stdout: '{"available":true,"text":"普通未知页面文字","lines":[]}' }),
  });
  const empty = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async () => ({ exitCode: 0, stdout: '{"available":true,"text":"","lines":[]}' }),
  });
  const scan = await readable({ imagePath: "screen.png" });
  assert.equal(scan.pageType, "UNKNOWN");
  assert.equal(scan.ocrAvailable, true);
  assert.equal(scan.safeForCloud, true);
  assert.equal(await empty({ imagePath: "screen.png" }), null);
});

test("permission, order, and privacy screens are sensitive local OCR results", () => {
  for (const text of [
    "需要相机权限 仅在使用时允许",
    "我的订单 订单详情",
    "账号与安全 隐私设置",
    "手机号 13800138000",
    "联系 user@example.com",
    "身份证 110101199001011234",
  ]) {
    const result = classifyLocalOcrText(text);
    assert.equal(result.pageType, "LOGIN_OR_CHALLENGE");
    assert.equal(result.humanRequired, true);
  }
});

test("Windows OCR adapter safely returns null when OCR is unavailable", async () => {
  const localOcr = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async () => ({ exitCode: 0, stdout: '{"available":false,"text":"","lines":[]}' }),
  });
  assert.equal(await localOcr({ imagePath: "missing.png" }), null);
  assert.equal(await localOcr({}), null);
});
