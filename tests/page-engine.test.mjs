import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyPage,
  classifySafety,
  createNormalizedFingerprint,
  normalizeDynamicText,
  parseUiAutomatorXml,
  resolveRuleProfile,
  resolveSemanticTarget,
  scorePageStates,
} from "../scripts/xhs-page-engine.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rules = JSON.parse(await readFile(new URL("../config/xhs-page-rules.json", import.meta.url), "utf8"));

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function node(attributes = {}) {
  const complete = {
    index: "0",
    text: "",
    "resource-id": "",
    class: "android.view.View",
    package: "com.xingin.xhs",
    "content-desc": "",
    clickable: "false",
    enabled: "true",
    focused: "false",
    scrollable: "false",
    password: "false",
    bounds: "[0,0][100,100]",
    ...attributes,
  };
  const serialized = Object.entries(complete)
    .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
    .join(" ");
  return `<node ${serialized} />`;
}

function hierarchy(...nodes) {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">${nodes.join("")}</hierarchy>`;
}

const stateFixtures = {
  HOME_FEED: hierarchy(
    node({ "resource-id": "com.xingin.xhs:id/tab_home", text: "首页", clickable: "true" }),
    node({ text: "关注" }),
    node({ "resource-id": "com.xingin.xhs:id/home_feed", class: "androidx.recyclerview.widget.RecyclerView", scrollable: "true" }),
  ),
  SEARCH_ENTRY: hierarchy(
    node({
      "resource-id": "com.xingin.xhs:id/search_input",
      class: "android.widget.EditText",
      text: "搜索",
      focused: "true",
      clickable: "true",
    }),
  ),
  SEARCH_SUGGESTIONS: hierarchy(
    node({ "resource-id": "com.xingin.xhs:id/search_input", class: "android.widget.EditText", text: "通勤", focused: "true" }),
    node({ text: "搜索发现" }),
    node({ "resource-id": "com.xingin.xhs:id/search_suggestion_list", class: "androidx.recyclerview.widget.RecyclerView", scrollable: "true" }),
  ),
  SEARCH_RESULTS: hierarchy(
    node({ "resource-id": "com.xingin.xhs:id/search_input", class: "android.widget.EditText", text: "夏季通勤" }),
    node({ text: "综合" }),
    node({ "resource-id": "com.xingin.xhs:id/search_result_list", class: "androidx.recyclerview.widget.RecyclerView", scrollable: "true" }),
  ),
  TRENDING: hierarchy(
    node({ text: "热搜榜" }),
    node({ "resource-id": "com.xingin.xhs:id/hot_rank", text: "1" }),
    node({ "resource-id": "com.xingin.xhs:id/hot_search_list", class: "androidx.recyclerview.widget.RecyclerView", scrollable: "true" }),
  ),
  RECOMMENDED: hierarchy(
    node({ text: "猜你想看" }),
    node({ text: "你可能感兴趣" }),
    node({ "resource-id": "com.xingin.xhs:id/recommend_list", class: "androidx.recyclerview.widget.RecyclerView", scrollable: "true" }),
  ),
  IMAGE_NOTE: hierarchy(
    node({ "resource-id": "com.xingin.xhs:id/image_pager", "content-desc": "第1张图片" }),
    node({ "resource-id": "com.xingin.xhs:id/note_title", text: "脱敏示例标题" }),
    node({ "resource-id": "com.xingin.xhs:id/comment_entry", text: "评论", clickable: "true" }),
  ),
  VIDEO_NOTE: hierarchy(
    node({ "resource-id": "com.xingin.xhs:id/video_player", "content-desc": "播放" }),
    node({ "resource-id": "com.xingin.xhs:id/note_title", text: "脱敏视频标题" }),
    node({ "resource-id": "com.xingin.xhs:id/comment_entry", text: "评论", clickable: "true" }),
  ),
  COMMENT_PANEL: hierarchy(
    node({ "resource-id": "com.xingin.xhs:id/comment_title", text: "共12条评论" }),
    node({ "resource-id": "com.xingin.xhs:id/comment_input", text: "说点什么...", clickable: "true" }),
    node({ "resource-id": "com.xingin.xhs:id/comment_panel", class: "android.app.Dialog" }),
  ),
  NETWORK_ERROR: hierarchy(
    node({ text: "网络开小差，请稍后重试" }),
    node({ "resource-id": "com.xingin.xhs:id/retry", text: "重试", clickable: "true" }),
  ),
  UPDATE_MODAL: hierarchy(
    node({ text: "发现新版本" }),
    node({ text: "立即更新", clickable: "true" }),
    node({ text: "以后再说", clickable: "true" }),
  ),
  LOGIN_OR_CHALLENGE: hierarchy(
    node({ text: "登录" }),
    node({ "resource-id": "com.xingin.xhs:id/verification_code", text: "请输入验证码", class: "android.widget.EditText" }),
    node({ text: "登录即代表同意用户协议" }),
  ),
  UNKNOWN: hierarchy(node({ text: "脱敏且未标定的页面" })),
};

test("uiautomator parser decodes attributes and preserves hierarchy without exposing bounds through semantic results", () => {
  const xml = `<?xml version="1.0"?><hierarchy><node text="父 &amp; 节点" clickable="true" enabled="true" bounds="[1,2][3,4]"><node text="子节点" enabled="true" /></node></hierarchy>`;
  const document = parseUiAutomatorXml(xml);
  assert.equal(document.nodes.length, 2);
  assert.equal(document.nodes[0].text, "父 & 节点");
  assert.deepEqual(document.nodes[0].children, [1]);
  assert.equal(document.nodes[1].parentIndex, 0);
});

test("all known states clear the score and margin gates; unmatched UI falls back to UNKNOWN", () => {
  for (const [expectedState, xml] of Object.entries(stateFixtures)) {
    const result = classifyPage(xml, rules);
    assert.equal(result.state, expectedState, `${expectedState}: ${JSON.stringify(result.candidates)}`);
    assert.equal(result.accepted, expectedState !== "UNKNOWN");
    if (expectedState !== "UNKNOWN") {
      assert.ok(result.score >= 0.85, `${expectedState} score ${result.score}`);
      assert.ok(result.margin >= 0.15, `${expectedState} margin ${result.margin}`);
    }
  }
});

test("ambiguous high-scoring states are rejected when the margin is below 0.15", () => {
  const ambiguousRules = {
    thresholds: { minimumScore: 0.85, minimumMargin: 0.15 },
    states: [
      { state: "HOME_FEED", evidence: [{ id: "same", weight: 1, any: [{ attribute: "text", match: "exact", values: ["相同"] }] }] },
      { state: "RECOMMENDED", evidence: [{ id: "same", weight: 1, any: [{ attribute: "text", match: "exact", values: ["相同"] }] }] },
      { state: "UNKNOWN", fallback: true, evidence: [] },
    ],
  };
  const result = classifyPage(hierarchy(node({ text: "相同" })), ambiguousRules);
  assert.equal(result.topCandidate, "HOME_FEED");
  assert.equal(result.score, 1);
  assert.equal(result.margin, 0);
  assert.equal(result.state, "UNKNOWN");
  assert.equal(result.accepted, false);
});

test("normalized fingerprints ignore bounds, counters, dates, and relative timestamps", () => {
  const first = hierarchy(
    node({ text: "共123条评论", "content-desc": "123", bounds: "[0,0][100,100]" }),
    node({ text: "3分钟前", bounds: "[0,100][100,200]" }),
  );
  const second = hierarchy(
    node({ text: "共999条评论", "content-desc": "999", bounds: "[500,500][900,900]" }),
    node({ text: "25分钟前", bounds: "[1,1][2,2]" }),
  );
  assert.equal(createNormalizedFingerprint(first).hash, createNormalizedFingerprint(second).hash);
  assert.equal(normalizeDynamicText("88"), "");
  assert.equal(normalizeDynamicText("共88条评论"), "共<n>条评论");
});

test("state scoring is deterministic and exposes evidence rather than screen coordinates", () => {
  const scored = scorePageStates(stateFixtures.NETWORK_ERROR, rules);
  assert.equal(scored[0].state, "NETWORK_ERROR");
  assert.deepEqual(scored[0].matchedEvidence, ["network-error-message", "retry-action"]);
  assert.equal(JSON.stringify(scored).includes("bounds"), false);
});

test("semantic target resolution prioritizes resource-id over exact text and content description", () => {
  const xml = hierarchy(
    node({ text: "搜索", clickable: "true" }),
    node({ "resource-id": "com.xingin.xhs:id/search_input", class: "android.widget.EditText", clickable: "true" }),
  );
  const target = resolveSemanticTarget(xml, rules, "search_entry");
  assert.equal(target.found, true);
  assert.equal(target.strategy, "resource-id");
  assert.match(target.selector.resourceId, /search_input/);
  assert.equal(JSON.stringify(target).includes("bounds"), false);
  assert.equal(JSON.stringify(target).includes("coordinate"), false);
});

test("stable parent-child relations are the final semantic fallback", () => {
  const relationRules = {
    states: [{ state: "UNKNOWN", fallback: true, evidence: [] }],
    semanticTargets: {
      relation_only: [
        {
          id: "label-clickable-parent",
          strategy: "relation",
          direction: "ancestor",
          maxDepth: 2,
          anchor: { attribute: "text", match: "exact", values: ["安全入口"] },
          node: { attribute: "clickable", equals: true },
        },
      ],
    },
  };
  const xml = `<?xml version="1.0"?><hierarchy><node class="android.view.ViewGroup" clickable="true" enabled="true"><node text="安全入口" enabled="true" /></node></hierarchy>`;
  const target = resolveSemanticTarget(xml, relationRules, "relation_only");
  assert.equal(target.found, true);
  assert.equal(target.strategy, "relation");
  assert.deepEqual(target.selector, { relation: "label-clickable-parent" });
  assert.equal(target.node.path, "/0");
});

test("unsupported coordinate selectors are ignored", () => {
  const coordinateRules = {
    states: [{ state: "UNKNOWN", fallback: true, evidence: [] }],
    semanticTargets: { forbidden: [{ strategy: "coordinate", x: 0.5, y: 0.5 }] },
  };
  assert.deepEqual(resolveSemanticTarget(stateFixtures.UNKNOWN, coordinateRules, "forbidden"), {
    semanticTarget: "forbidden",
    found: false,
    reason: "no-semantic-match",
  });
});

test("login/challenge and other sensitive screens always require a human and block cloud upload", () => {
  const login = classifyPage(stateFixtures.LOGIN_OR_CHALLENGE, rules);
  assert.equal(login.safety.sensitive, true);
  assert.equal(login.safety.challenge, true);
  assert.equal(login.safety.requiresHuman, true);
  assert.equal(login.safety.blockCloudUpload, true);

  const payment = classifySafety(hierarchy(node({ text: "收银台" })), rules, "UNKNOWN");
  assert.deepEqual(payment.reasons, ["payment-screen"]);
  assert.equal(payment.requiresHuman, true);
  assert.equal(payment.blockCloudUpload, true);

  const permission = classifySafety(hierarchy(node({ text: "仅在使用时允许" })), rules, "UNKNOWN");
  assert.deepEqual(permission.reasons, ["permission-prompt"]);
  assert.equal(permission.challenge, true);
  assert.equal(permission.requiresHuman, true);
  assert.equal(permission.blockCloudUpload, true);

  const privateAccount = classifySafety(hierarchy(node({ text: "订单详情" })), rules, "UNKNOWN");
  assert.deepEqual(privateAccount.reasons, ["orders-account-or-private-screen"]);
  assert.equal(privateAccount.blockCloudUpload, true);
});

test("device overrides only activate for the exact calibrated app version", () => {
  const localRules = structuredClone(rules);
  localRules.deviceOverrides = [
    {
      id: "sanitized-device-profile",
      match: { deviceAlias: "content-01", resolution: "1080x2400", dpi: "420" },
      calibratedXhsVersion: "9.9.9",
      semanticTargets: { special: [{ strategy: "text", values: ["标定入口"] }] },
    },
  ];
  assert.equal(
    resolveRuleProfile(localRules, { deviceAlias: "content-01", resolution: "1080x2400", dpi: "420", xhsVersion: "9.9.9" }).overrideId,
    "sanitized-device-profile",
  );
  assert.equal(
    resolveRuleProfile(localRules, { deviceAlias: "content-01", resolution: "1080x2400", dpi: "420", xhsVersion: "9.9.10" }).overrideId,
    null,
  );
});

test("CLI classify emits JSON and uses the default rules file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xhs-page-engine-"));
  const xmlPath = join(directory, "sanitized.xml");
  try {
    await writeFile(xmlPath, stateFixtures.NETWORK_ERROR, "utf8");
    const run = spawnSync(process.execPath, [join(projectRoot, "scripts", "xhs-page-engine.mjs"), "classify", "--xml", xmlPath], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.state, "NETWORK_ERROR");
    assert.equal(result.accepted, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
