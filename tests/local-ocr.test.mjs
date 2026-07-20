import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { classifyLocalOcrText, createWindowsLocalOcr } from "../scripts/local-ocr.mjs";
import { POWERSHELL_EXECUTABLE } from "../scripts/powershell-runtime.mjs";

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

test("local OCR normalizes Han-character spacing without turning public Alipay text into a payment screen", () => {
  assert.equal(classifyLocalOcrText("搜 索 猜 你 想 搜 历 史 记 录").pageType, "SEARCH_ENTRY");
  assert.equal(classifyLocalOcrText("支付宝批量起诉"), null);
  assert.equal(classifyLocalOcrText("收 银 台").pageType, "LOGIN_OR_CHALLENGE");
  assert.equal(classifyLocalOcrText("确 认 支 付 金 额").pageType, "LOGIN_OR_CHALLENGE");
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
  const expectedOcrShell = process.platform === "win32" && process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : POWERSHELL_EXECUTABLE;
  assert.equal(invocation.file, expectedOcrShell);
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

test("exact local OCR passes only semantic crop coordinates and a normalized hash", async () => {
  const invocations = [];
  const localOcr = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async (input) => {
      invocations.push(input);
      return { exitCode: 0, stdout: '{"available":true,"matched":true}' };
    },
  });
  const input = {
    mode: "exact_text",
    imagePath: "C:\\temp\\screen.png",
    bounds: { left: 166, top: 95, right: 776, bottom: 216 },
    expectedText: "adidas\u9a8c\u771f\u4f2a",
  };
  const result = await localOcr(input);
  const args = invocations[0].args;
  assert.deepEqual(args.slice(args.indexOf("-CropX"), args.indexOf("-ExpectedTextHash")), [
    "-CropX", "166", "-CropY", "95", "-CropWidth", "610", "-CropHeight", "121", "-RequireChinese",
  ]);
  const digest = args.at(-1);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(args.includes(input.expectedText), false);
  assert.deepEqual(result, {
    exactTextMatch: true,
    matchMode: "normalized_exact",
    ocrAvailable: true,
    source: "windows_local_ocr",
    safeForCloud: false,
  });
  assert.equal(JSON.stringify(result).includes(input.expectedText), false);
  assert.equal(JSON.stringify(result).includes(input.imagePath), false);
  assert.equal(JSON.stringify(result).includes(digest), false);
});

test("Windows OCR adapter prefers the Windows PowerShell 5.1 executable for WinRT interop", async () => {
  const invocations = [];
  const localOcr = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async (input) => {
      invocations.push(input);
      return { exitCode: 0, stdout: '{"available":true,"matched":true}' };
    },
  });
  await localOcr({
    mode: "exact_text", imagePath: "screen.png",
    bounds: { left: 1, top: 2, right: 101, bottom: 42 }, expectedText: "测试",
  });
  assert.match(invocations[0].file, /powershell\.exe$/iu);
  assert.doesNotMatch(invocations[0].file, /pwsh/iu);
});

test("exact local OCR joins topic-tag markers with spaced Han characters", async () => {
  const hashes = [];
  const localOcr = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async ({ args }) => {
      hashes.push(args.at(-1));
      return { exitCode: 0, stdout: '{"available":true,"matched":false}' };
    },
  });
  const base = {
    mode: "exact_text",
    imagePath: "screen.png",
    bounds: { left: 1, top: 2, right: 101, bottom: 42 },
  };
  await localOcr({ ...base, expectedText: "#酸奶推荐" });
  await localOcr({ ...base, expectedText: "# 酸 奶 推 荐" });
  await localOcr({ ...base, expectedText: "# 酸 奶 推 荐 ！" });
  assert.equal(hashes[0], hashes[1]);
  assert.notEqual(hashes[0], hashes[2]);
});

test("exact local OCR normalizes script-boundary spacing but never accepts a substring", async () => {
  const hashes = [];
  const localOcr = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async ({ args }) => {
      hashes.push(args.at(-1));
      return { exitCode: 0, stdout: '{"available":true,"matched":false}' };
    },
  });
  const base = {
    mode: "exact_text",
    imagePath: "screen.png",
    bounds: { left: 1, top: 2, right: 101, bottom: 42 },
  };
  const first = await localOcr({ ...base, expectedText: "adidas\u9a8c\u771f\u4f2a" });
  await localOcr({ ...base, expectedText: "adidas \u9a8c \u771f \u4f2a" });
  await localOcr({ ...base, expectedText: "adidas\u9a8c\u771f\u4f2a\u7248" });
  assert.equal(first.exactTextMatch, false);
  assert.equal(hashes[0], hashes[1]);
  assert.notEqual(hashes[0], hashes[2]);
});

test("exact local OCR fails closed for invalid requests or raw-text payloads", async () => {
  let calls = 0;
  const invalid = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async () => { calls += 1; return { exitCode: 0, stdout: '{"available":true,"matched":true}' }; },
  });
  assert.equal(await invalid({ mode: "exact_text", imagePath: "screen.png", expectedText: "x" }), null);
  assert.equal(await invalid({ mode: "exact_text", imagePath: "screen.png", expectedText: "x", bounds: { left: 1, top: 1, right: 1, bottom: 2 } }), null);
  assert.equal(await invalid({ mode: "page_safety", imagePath: "screen.png", bounds: { left: 1, top: 1, right: 2, bottom: 2 } }), null);
  assert.equal(calls, 0);

  const leaking = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async () => ({
      exitCode: 0,
      stdout: '{"available":true,"matched":true,"text":"private-ocr-sentinel"}',
    }),
  });
  assert.equal(await leaking({
    mode: "exact_text",
    imagePath: "screen.png",
    expectedText: "x",
    bounds: { left: 1, top: 1, right: 2, bottom: 2 },
  }), null);
});

test("locate-text OCR returns only typed bounds and never passes plaintext to the host script", async () => {
  let invocation;
  const localOcr = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async (input) => {
      invocation = input;
      return {
        exitCode: 0,
        stdout: '{"available":true,"matches":[{"left":810,"top":2100,"right":850,"bottom":2140}]}',
      };
    },
  });
  const result = await localOcr({ mode: "locate_text", imagePath: "screen.png", expectedText: "我" });
  assert.deepEqual(result, {
    matches: [{ left: 810, top: 2100, right: 850, bottom: 2140 }],
    matchMode: "normalized_exact",
    ocrAvailable: true,
    source: "windows_local_ocr",
    safeForCloud: false,
  });
  assert.ok(invocation.args.includes("locate_text"));
  assert.ok(invocation.args.includes("-RequireChinese"));
  assert.equal(invocation.args.includes("我"), false);
  assert.match(invocation.args.at(-1), /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(result), /screen\.png|我/u);
});

test("locate-text OCR merges overlapping line and word boxes but preserves separate duplicate targets", async () => {
  const localOcr = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        available: true,
        matches: [
          { left: 800, top: 2100, right: 860, bottom: 2160 },
          { left: 805, top: 2105, right: 855, bottom: 2155 },
          { left: 100, top: 100, right: 160, bottom: 160 },
        ],
      }),
    }),
  });
  const result = await localOcr({ mode: "locate_text", imagePath: "screen.png", expectedText: "我" });
  assert.deepEqual(result.matches, [
    { left: 800, top: 2100, right: 860, bottom: 2160 },
    { left: 100, top: 100, right: 160, bottom: 160 },
  ]);
});

test("numeric-count OCR uses a bounded crop and returns only a typed count observation", async () => {
  let invocation;
  const localOcr = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async (input) => {
      invocation = input;
      return {
        exitCode: 0,
        stdout: '{"available":true,"candidates":["99+","99+"]}',
      };
    },
  });
  const result = await localOcr({
    mode: "numeric_count",
    imagePath: "C:\\\\temp\\\\count.png",
    bounds: { left: 10, top: 20, right: 210, bottom: 100 },
  });
  assert.ok(invocation.args.includes("numeric_count"));
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf("-CropX"), invocation.args.indexOf("-Mode")), [
    "-CropX", "10", "-CropY", "20", "-CropWidth", "200", "-CropHeight", "80",
  ]);
  assert.deepEqual(result, {
    count: 99,
    countKind: "lower_bound",
    confidence: 1,
    ocrAvailable: true,
    source: "windows_local_ocr",
    safeForCloud: false,
  });
  assert.equal(JSON.stringify(result).includes("99+"), false);
  assert.equal(JSON.stringify(result).includes("count.png"), false);
});

test("numeric-count OCR fails closed for malformed requests, conflicts, and payload leakage", async () => {
  let calls = 0;
  const localOcr = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async () => {
      calls += 1;
      return { exitCode: 0, stdout: '{"available":true,"candidates":["5","6"]}' };
    },
  });
  assert.equal(await localOcr({ mode: "numeric_count", imagePath: "screen.png" }), null);
  assert.equal(await localOcr({
    mode: "numeric_count", imagePath: "screen.png", bounds: { left: 1, top: 1, right: 1, bottom: 2 },
  }), null);
  assert.equal(calls, 0);
  assert.deepEqual(await localOcr({
    mode: "numeric_count", imagePath: "screen.png", bounds: { left: 1, top: 1, right: 20, bottom: 20 },
  }), {
    count: null, countKind: "unknown", confidence: 0, ocrAvailable: true,
    source: "windows_local_ocr", safeForCloud: false,
  });

  const leaking = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async () => ({ exitCode: 0, stdout: '{"available":true,"candidates":["5"],"text":"secret"}' }),
  });
  assert.equal(await leaking({
    mode: "numeric_count", imagePath: "screen.png", bounds: { left: 1, top: 1, right: 20, bottom: 20 },
  }), null);
});

test("currency OCR returns one typed CNY minor-unit value without raw page text", async () => {
  const localOcr = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ available: true, candidates: ["¥12.30", "12.30元"] }),
    }),
  });
  const result = await localOcr({ mode: "currency_amount", imagePath: "wallet.png" });
  assert.deepEqual(result, {
    currencyAmounts: [{ currency: "CNY", amountMinor: 1230 }],
    ocrAvailable: true,
    source: "windows_local_ocr",
    safeForCloud: false,
  });
  assert.doesNotMatch(JSON.stringify(result), /wallet\.png|¥|元/u);

  const malformed = createWindowsLocalOcr({
    enabled: true,
    commandRunner: async () => ({ exitCode: 0, stdout: '{"available":true,"candidates":["12:30"]}' }),
  });
  assert.equal(await malformed({ mode: "currency_amount", imagePath: "wallet.png" }), null);
});
