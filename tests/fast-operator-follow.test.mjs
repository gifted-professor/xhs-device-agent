// fixture 测试：xhs.follow.ensure 的解析与流程。
// fast-operator 节点 idiom：doc.nodes[i] = {text, contentDesc, className, bounds:[L,T,R,B], clickable, enabled, ...}
// helpers（profileOverlayOpen / profileAuthor / findFollowBtn）只读 doc + centerOf(bounds)，不碰 session。
// followEnsure 流程靠 stub 掉 dump/tap/currentFocus/backFromProfile/pace/metricsSummary 在 fixture 层验证。
//
// 几何复刻真实 overlay-01.xml 的主页浮层结构（registry Task A 4 轮对抗验证的同一证据）：
//   全屏 root [0,0,1080,2400]；tier-1 头像 [5,215,302,512]（cy=363，clickable ImageView + desc「头像,<name>」）；
//   背景控件 y≈161（头像上方 → 拒）；统计 tab [44,534,184,600]（宽 140 → 拒）；浮层主 CTA [33,954,474,1042]（cy=998，宽 441 → 选）。
// 注意 GPFS centerOf 用 bitwise 截断：(33+474)/2|0 = 253（registry 用 Math.round=254）；CTA 中心断言用 [253,998]。
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { FastOperator, parseUiAutomatorXml } from "../scripts/fast-operator.mjs";

// 合成节点。center = [(L+R)/2|0, (T+B)/2|0]（与 fast-operator.centerOf 一致）。
function node({ text = "", desc = "", cls = "android.widget.TextView", bounds = [0, 0, 100, 100], clickable = false } = {}) {
  return { text, contentDesc: desc, className: cls, bounds, clickable, enabled: true };
}
const doc = (nodes, extra = {}) => ({ nodes, _dumpMs: 1, _label: "test", ...extra });

// 主页浮层几何 helpers（复刻 overlay-01.xml）。
function root(bounds = [0, 0, 1080, 2400]) {
  return node({ cls: "android.widget.FrameLayout", bounds, clickable: false });
}
// tier-1 浮层头像：clickable ImageView + content-desc「头像,<name>」。
function avatar(name, bounds = [5, 215, 302, 512]) {
  return node({ desc: `头像,${name}`, cls: "android.widget.ImageView", bounds, clickable: true });
}
// 浮层主 CTA：clickable FrameLayout 容器 + 非 clickable TextView label 套在内（真实结构：label 非可点、容器可点）。
function overlayCta(label, { via = "text", cBounds = [33, 954, 474, 1042], lBounds = [215, 971, 293, 1026] } = {}) {
  return [
    node({ cls: "android.widget.FrameLayout", bounds: cBounds, clickable: true }),
    node({ text: via === "text" ? label : "", desc: via === "desc" ? label : "", cls: "android.widget.TextView", bounds: lBounds, clickable: false }),
  ];
}
// 统计 tab（粉丝/获赞/关注等）：窄 clickable Button + label，宽 140 < minCtaW → 必被拒。
function statTab(label, { cBounds = [44, 534, 184, 600], lBounds = [108, 536, 184, 597] } = {}) {
  return [
    node({ cls: "android.widget.Button", bounds: cBounds, clickable: true }),
    node({ text: label, cls: "android.widget.TextView", bounds: lBounds, clickable: false }),
  ];
}
// 背景控件：头像上方的 clickable FrameLayout + label（cy < av.cy → 拒）。
function bgControl(label, { cBounds = [222, 122, 395, 199], lBounds = [222, 122, 395, 199] } = {}) {
  return [
    node({ cls: "android.widget.FrameLayout", bounds: cBounds, clickable: true }),
    node({ text: label, cls: "android.widget.TextView", bounds: lBounds, clickable: false }),
  ];
}

// stub 出一个只跑解析+流程、无设备的 operator。afterDoc 控制 tap 后重 dump 的结果。
function makeOp({ afterDoc = null } = {}) {
  const op = new FastOperator({});
  const taps = [];
  op.currentFocus = async () => ({ activity: "NoteDetailActivity" });
  op.pace = async () => {};
  op.tap = async (x, y) => { taps.push([x, y]); return { ok: true }; };
  op.dump = async (opts) => afterDoc ?? doc([], { _label: opts?.label });
  op.backFromProfile = async (n) => ({ back: n, activity: "IndexActivityV2" });
  op.metricsSummary = () => ({ actions: 0 });
  return { op, taps };
}

// ---------- 纯解析：findFollowBtn 四状态 + desc-only + via + 缺失 + 假阳排除 ----------
test("findFollowBtn classifies the four follow states (text and desc separately)", () => {
  const op = new FastOperator({});
  const at = (label, via = "text") => doc([root(), avatar("张三"), ...overlayCta(label, { via })]);
  assert.equal(op.findFollowBtn(at("关注")).state, "not_followed");
  assert.equal(op.findFollowBtn(at("已关注")).state, "followed");
  assert.equal(op.findFollowBtn(at("回关")).state, "not_followed");
  assert.equal(op.findFollowBtn(at("相互关注")).state, "followed");
  // desc-only：text 空、contentDesc=关注 仍命中
  assert.equal(op.findFollowBtn(at("关注", "desc")).state, "not_followed");
  assert.equal(op.findFollowBtn(at("已关注", "desc")).state, "followed");
  // via 字段如实反映命中来源
  assert.equal(op.findFollowBtn(at("关注", "desc")).via, "contentDesc");
  assert.equal(op.findFollowBtn(at("关注", "text")).via, "text");
});

test("findFollowBtn returns null when no follow button is present", () => {
  const op = new FastOperator({});
  // 有头像有 root 但无 CTA → fail-closed
  assert.equal(op.findFollowBtn(doc([root(), avatar("张三")])), null);
  // 空 dump → 无头像指纹 → null
  assert.equal(op.findFollowBtn(doc([])), null);
});

test("findFollowBtn rejects false-positive labels like 关注的话题 (exact-set, not includes)", () => {
  const op = new FastOperator({});
  // 「关注的话题」不是四态 → 不产生候选 → null
  const fp = doc([
    root(), avatar("张三"),
    node({ cls: "android.widget.FrameLayout", bounds: [33, 954, 474, 1042], clickable: true }),
    node({ text: "关注的话题", cls: "android.widget.TextView", bounds: [215, 971, 293, 1026], clickable: false }),
  ]);
  assert.equal(op.findFollowBtn(fp), null);
  // 同屏有真「关注」CTA 仍命中
  const mixed = doc([
    root(), avatar("张三"),
    node({ text: "关注的话题", cls: "android.widget.TextView", bounds: [100, 960, 300, 1020], clickable: false }),
    ...overlayCta("关注"),
  ]);
  assert.equal(op.findFollowBtn(mixed).state, "not_followed");
});

// ---------- 纯解析：profileOverlayOpen + profileAuthor（不依赖 findFollowBtn，保持既有行为） ----------
test("profileOverlayOpen detects the overlay signal (clickable ImageView + desc + y<600)", () => {
  const op = new FastOperator({});
  assert.equal(op.profileOverlayOpen(doc([avatar("张三", [40, 100, 200, 260])])), true);
  // y>=600 不算浮层头像
  assert.equal(op.profileOverlayOpen(doc([avatar("张三", [40, 700, 200, 860])])), false);
  // 非 clickable 或无 contentDesc 不算
  assert.equal(op.profileOverlayOpen(doc([node({ desc: "头像,张三", cls: "android.widget.ImageView", bounds: [40, 100, 200, 260], clickable: false })])), false);
  assert.equal(op.profileOverlayOpen(doc([node({ cls: "android.widget.ImageView", bounds: [40, 100, 200, 260], clickable: true })])), false);
  assert.equal(op.profileOverlayOpen(doc([])), false);
});

test("profileAuthor tier-1 extracts name from 头像,<name>; tier-1 miss returns name:null + fallback", () => {
  const op = new FastOperator({});
  assert.deepEqual(op.profileAuthor(doc([avatar("张三", [40, 100, 200, 260])])), { name: "张三", fallback: null });
  assert.equal(op.profileAuthor(doc([avatar("张三,二店", [40, 100, 200, 260])])).name, "张三,二店");
  const noAvatar = doc([
    node({ text: "李四", cls: "android.widget.TextView", bounds: [300, 120, 600, 170], clickable: false }),
    node({ text: "粉丝 123", cls: "android.widget.TextView", bounds: [300, 180, 600, 230], clickable: false }),
  ]);
  const r = op.profileAuthor(noAvatar);
  assert.equal(r.name, null);
  assert.equal(r.fallback, "李四");
  assert.deepEqual(op.profileAuthor(doc([])), { name: null, fallback: null });
});

// ---------- 主页浮层消歧（registry Task A 4 轮对抗验证语义 port） ----------
test("findFollowBtn selects the wide overlay CTA below the avatar, not background/statistic labels", () => {
  const op = new FastOperator({});
  const nodes = [
    root(),
    avatar("张三"),
    ...bgControl("关注"), // y=161 头像上方 → 拒
    ...statTab("关注"), // y=567 宽 140 → 拒
    ...overlayCta("关注"), // y=998 宽 441 → 选
  ];
  const hit = op.findFollowBtn(doc(nodes));
  assert.equal(hit.label, "关注");
  assert.equal(hit.state, "not_followed");
  assert.deepEqual(hit.center, [253, 998]);
  assert.deepEqual(hit.bounds, [33, 954, 474, 1042]);
});

test("findFollowBtn fails closed on two distinct same-center containers (dedupe by bounds)", () => {
  const op = new FastOperator({});
  const A = [10, 900, 500, 1100];
  const B = [50, 920, 460, 1080]; // 套在 A 内，与 A 同中心 (255,1000)
  const nodes = [
    root(), avatar("张三"),
    node({ cls: "android.widget.FrameLayout", bounds: A, clickable: true }),
    node({ cls: "android.widget.FrameLayout", bounds: B, clickable: true }),
    // label1 在 B 内（A 也包住）→ 最小容器 B
    node({ text: "关注", cls: "android.widget.TextView", bounds: [200, 950, 260, 1010], clickable: false }),
    // label2 在 A 内但 B 外（x=470 > B.R=460）→ 最小容器 A
    node({ text: "关注", cls: "android.widget.TextView", bounds: [470, 990, 490, 1010], clickable: false }),
  ];
  assert.equal(op.findFollowBtn(doc(nodes)), null);
});

test("findFollowBtn derives screen width from root, not global max R (offscreen inflation)", () => {
  const op = new FastOperator({});
  const nodes = [
    root(), // [0,0,1080,2400] → 屏宽 1080，minCtaW 324
    avatar("张三"),
    // 离屏无关节点 R=2000：旧全局 max R 会抬高阈值误拒 441 的 CTA
    node({ cls: "android.widget.FrameLayout", bounds: [1900, 0, 2000, 100], clickable: false }),
    ...overlayCta("关注"), // 宽 441 → [253,998]
  ];
  const hit = op.findFollowBtn(doc(nodes));
  assert.equal(hit.label, "关注");
  assert.deepEqual(hit.center, [253, 998]);
});

test("findFollowBtn returns null when no trustworthy full-screen root exists (sparse dump)", () => {
  const op = new FastOperator({});
  // 仅头像 + 140 统计 tab，无含头像且宽>2×头像宽的 root → 无法确立屏宽 → null
  const nodes = [avatar("张三"), ...statTab("关注")];
  assert.equal(op.findFollowBtn(doc(nodes)), null);
});

test("findFollowBtn returns null on a truncated dump whose first node is sub-screen and does not wrap the avatar", () => {
  const op = new FastOperator({});
  const nodes = [
    node({ cls: "android.widget.FrameLayout", bounds: [0, 500, 200, 700], clickable: false }), // 子屏片段，不含头像
    avatar("张三"),
    ...statTab("关注"),
  ];
  assert.equal(op.findFollowBtn(doc(nodes)), null);
});

test("findFollowBtn excludes a page-sized clickable wrapper from CTA ancestors", () => {
  const op = new FastOperator({});
  // 全屏 clickable wrapper 包住裸 follow label 但无真实 CTA → wrapper 宽 1080 ≥ 0.9×屏宽 → 排除 → null
  const nodes = [
    node({ cls: "android.widget.FrameLayout", bounds: [0, 0, 1080, 2400], clickable: true }),
    avatar("张三"),
    node({ text: "关注", cls: "android.widget.TextView", bounds: [500, 1180, 580, 1220], clickable: false }),
  ];
  assert.equal(op.findFollowBtn(doc(nodes)), null);
});

test("findFollowBtn picks the follow-state field when text and desc conflict", () => {
  const op = new FastOperator({});
  // text="按钮" 与 content-desc="关注" 冲突 → matched 取四态字段「关注」，via=contentDesc
  const nodes = [
    root(), avatar("张三"),
    node({ cls: "android.widget.FrameLayout", bounds: [33, 954, 474, 1042], clickable: true }),
    node({ text: "按钮", desc: "关注", cls: "android.widget.TextView", bounds: [215, 971, 293, 1026], clickable: false }),
  ];
  const hit = op.findFollowBtn(doc(nodes));
  assert.ok(hit, "expected a CTA hit");
  assert.equal(hit.label, "关注");
  assert.equal(hit.state, "not_followed");
  assert.equal(hit.via, "contentDesc");
});

test("findFollowBtn fails closed when the minimal clickable ancestor is not unique (same area, different bounds)", () => {
  const op = new FastOperator({});
  // C1=[0,900,440,1100] 与 C2=[200,900,640,1100]：均 440×200=88000，互不包含但重叠；
  // label [300,1000,340,1010] 落在重叠区 → 两个都是最小容器 → 多候选 → null。
  const nodes = [
    root(), avatar("张三"),
    node({ cls: "android.widget.FrameLayout", bounds: [0, 900, 440, 1100], clickable: true }),
    node({ cls: "android.widget.FrameLayout", bounds: [200, 900, 640, 1100], clickable: true }),
    node({ text: "关注", cls: "android.widget.TextView", bounds: [300, 1000, 340, 1010], clickable: false }),
  ];
  assert.equal(op.findFollowBtn(doc(nodes)), null);
});

test("findFollowBtn returns null when only a sub-screen wrapper (not full-width) contains the avatar", () => {
  const op = new FastOperator({});
  // 截断 wrapper [0,0,400,700] 含头像但宽 400 < 2×头像宽(594) → 不可信 root → null
  const nodes = [
    node({ cls: "android.widget.FrameLayout", bounds: [0, 0, 400, 700], clickable: false }),
    avatar("张三"),
    ...statTab("关注"),
  ];
  assert.equal(op.findFollowBtn(doc(nodes)), null);
});

test("findFollowBtn fails closed on conflicting follow states in the same CTA (order: 关注 then 已关注)", () => {
  const op = new FastOperator({});
  const nodes = [
    root(), avatar("张三"),
    node({ cls: "android.widget.FrameLayout", bounds: [33, 954, 474, 1042], clickable: true }),
    node({ text: "关注", cls: "android.widget.TextView", bounds: [215, 971, 293, 1026], clickable: false }),
    node({ text: "已关注", cls: "android.widget.TextView", bounds: [250, 975, 290, 1020], clickable: false }),
  ];
  assert.equal(op.findFollowBtn(doc(nodes)), null);
});

test("findFollowBtn fails closed on conflicting follow states in the same CTA (order: 已关注 then 关注)", () => {
  const op = new FastOperator({});
  const nodes = [
    root(), avatar("张三"),
    node({ cls: "android.widget.FrameLayout", bounds: [33, 954, 474, 1042], clickable: true }),
    node({ text: "已关注", cls: "android.widget.TextView", bounds: [215, 971, 293, 1026], clickable: false }),
    node({ text: "关注", cls: "android.widget.TextView", bounds: [250, 975, 290, 1020], clickable: false }),
  ];
  assert.equal(op.findFollowBtn(doc(nodes)), null);
});

test("findFollowBtn fails closed when one node has contradictory text and desc follow states", () => {
  const op = new FastOperator({});
  const nodes = [
    root(), avatar("张三"),
    node({ cls: "android.widget.FrameLayout", bounds: [33, 954, 474, 1042], clickable: true }),
    node({ text: "关注", desc: "已关注", cls: "android.widget.TextView", bounds: [215, 971, 293, 1026], clickable: false }),
  ];
  assert.equal(op.findFollowBtn(doc(nodes)), null);
});

test("findFollowBtn clean single CTA → [253,998] 关注 (no false negative)", () => {
  const op = new FastOperator({});
  const hit = op.findFollowBtn(doc([root(), avatar("张三"), ...overlayCta("关注")]));
  assert.deepEqual(hit.center, [253, 998]);
  assert.equal(hit.label, "关注");
  assert.equal(hit.state, "not_followed");
});

// ---------- 真实 dump 离线 replay（只读，无设备 IO；GPFS 未挂载证据目录时跳过） ----------
const EVIDENCE_DIR = "/Volumes/GPFS/Users/a1234/Desktop/Coding/evidence/xhs-follow-ensure-20260729";
const overlayPath = `${EVIDENCE_DIR}/overlay-01.xml`;
const detailPath = `${EVIDENCE_DIR}/detail-negative-01.xml`;
function sha256(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

test("real-dump replay: overlay-01 → CTA [253,998] 关注; detail-negative-01 → null", { skip: existsSync(overlayPath) ? undefined : "GPFS evidence dir not mounted" }, () => {
  const op = new FastOperator({});
  // 证据完整性：SHA256 锚定（与 registry Task A 验收同一证据）
  assert.equal(sha256(overlayPath), "243a513a2284d05ef7c8dd5961a70853e4307931d28eaaad210378c336e09f3c");
  assert.equal(sha256(detailPath), "ce55e7f749b5712fe3780b74c1ee26e6df80482f81d87cbcb1c061fb35ae0f28");
  const overlayDoc = parseUiAutomatorXml(readFileSync(overlayPath, "utf8"));
  const hit = op.findFollowBtn(overlayDoc);
  // 只断言坐标/label/state；不断言 nor log avatar desc（真实账号昵称，不进结果）
  assert.deepEqual(hit.bounds, [33, 954, 474, 1042]);
  assert.deepEqual(hit.center, [253, 998]);
  assert.equal(hit.label, "关注");
  assert.equal(hit.state, "not_followed");
  const detailDoc = parseUiAutomatorXml(readFileSync(detailPath, "utf8"));
  assert.equal(op.findFollowBtn(detailDoc), null);
});

// ---------- 流程：followEnsure（stub 掉设备 IO）----------
test("followEnsure: not_followed → tap → followed (ok, one tap)", async () => {
  const beforeDoc = doc([root(), avatar("张三"), ...overlayCta("关注")]);
  const afterDoc = doc([root(), avatar("张三"), ...overlayCta("已关注")]);
  const { op, taps } = makeOp({ afterDoc });
  const r = await op.followEnsure({ targetUser: "张三", doc: beforeDoc });
  assert.equal(r.ok, true);
  assert.equal(r.step, "followed");
  assert.equal(r.beforeState, "not_followed");
  assert.equal(r.afterState, "followed");
  assert.equal(r.verified, true);
  assert.equal(r.sent, true);
  assert.equal(r.authorMatched, true);
  assert.equal(taps.length, 1);
  assert.equal(r.targetUser, "张三");
  assert.equal(r.extractedAuthor, "张三");
});

test("followEnsure: already followed → idempotent skip, NO tap", async () => {
  const beforeDoc = doc([root(), avatar("张三"), ...overlayCta("已关注")]);
  const { op, taps } = makeOp({ afterDoc: doc([root(), avatar("张三"), ...overlayCta("已关注")]) });
  const r = await op.followEnsure({ targetUser: "张三", doc: beforeDoc });
  assert.equal(r.ok, true);
  assert.equal(r.step, "already_followed");
  assert.equal(r.beforeState, "followed");
  assert.equal(r.afterState, "followed");
  assert.equal(r.sent, false);
  assert.equal(r.authorMatched, true);
  assert.equal(taps.length, 0);
});

test("followEnsure: wrong target (author=张三, targetUser=李四) → authorMismatch, fail-closed, NO tap", async () => {
  const beforeDoc = doc([root(), avatar("张三"), ...overlayCta("关注")]);
  const { op, taps } = makeOp({ afterDoc: doc([root(), avatar("张三"), ...overlayCta("已关注")]) });
  const r = await op.followEnsure({ targetUser: "李四", doc: beforeDoc });
  assert.equal(r.ok, false);
  assert.equal(r.step, "authorMismatch");
  assert.equal(r.sent, false);
  assert.equal(r.authorMatched, false);
  assert.equal(r.extractedAuthor, "张三");
  assert.equal(taps.length, 0);
});

test("followEnsure: normalize collision safety — a-b≠ab, 张·三≠张三 (fail-closed, NO tap)", async () => {
  const op = new FastOperator({});
  const r1 = await op.followEnsure({ targetUser: "ab", doc: doc([root(), avatar("a-b"), ...overlayCta("关注")]) });
  assert.equal(r1.step, "authorMismatch");
  assert.equal(r1.sent, false);
  assert.equal(r1.authorMatched, false);
  const r2 = await op.followEnsure({ targetUser: "张三", doc: doc([root(), avatar("张·三"), ...overlayCta("关注")]) });
  assert.equal(r2.step, "authorMismatch");
  assert.equal(r2.authorMatched, false);
});

test("followEnsure: author unreadable (overlay open but avatar desc format unknown) → authorMismatch, fail-closed, NO tap", async () => {
  // 浮层在（clickable ImageView + desc + y<600 通过 profileOverlayOpen），但头像 desc 不是「头像,<name>」
  // → tier-1 miss → name:null → authorMismatch（findFollowBtn 未达）。
  const beforeDoc = doc([
    node({ desc: "背景图", cls: "android.widget.ImageView", bounds: [40, 100, 200, 260], clickable: true }),
    ...overlayCta("关注"),
  ]);
  const { op, taps } = makeOp({ afterDoc: doc([root(), avatar("张三"), ...overlayCta("已关注")]) });
  const r = await op.followEnsure({ targetUser: "张三", doc: beforeDoc });
  assert.equal(r.ok, false);
  assert.equal(r.step, "authorMismatch");
  assert.equal(taps.length, 0);
});

test("followEnsure: follow button missing (author matches) → followBtnNotFound, NO tap", async () => {
  const beforeDoc = doc([root(), avatar("张三")]); // 有头像有 root，无 CTA
  const { op, taps } = makeOp({ afterDoc: doc([root(), avatar("张三"), ...overlayCta("已关注")]) });
  const r = await op.followEnsure({ targetUser: "张三", doc: beforeDoc });
  assert.equal(r.ok, false);
  assert.equal(r.step, "followBtnNotFound");
  assert.equal(r.sent, false);
  assert.equal(r.authorMatched, true);
  assert.equal(taps.length, 0);
});

test("followEnsure: afterState empty after tap → not success (req#7), sent=true (ambiguous, NOT notSent)", async () => {
  const beforeDoc = doc([root(), avatar("张三"), ...overlayCta("关注")]);
  const afterDoc = doc([root(), avatar("张三")]); // tap 后 CTA 丢失 → afterState=""
  const { op, taps } = makeOp({ afterDoc });
  const r = await op.followEnsure({ targetUser: "张三", doc: beforeDoc });
  assert.equal(r.ok, false);
  assert.equal(r.step, "afterStateUnknown");
  assert.equal(r.afterState, "");
  assert.equal(r.verified, false);
  assert.equal(r.sent, true);
  assert.equal(r.authorMatched, true);
  assert.equal(taps.length, 1);
});

test("followEnsure: not on profile overlay → notOnProfileOverlay, NO tap", async () => {
  const beforeDoc = doc([...overlayCta("关注")]); // 无浮层头像信号
  const { op, taps } = makeOp({ afterDoc: doc([root(), avatar("张三"), ...overlayCta("已关注")]) });
  const r = await op.followEnsure({ targetUser: "张三", doc: beforeDoc });
  assert.equal(r.ok, false);
  assert.equal(r.step, "notOnProfileOverlay");
  assert.equal(r.sent, false);
  assert.equal(r.authorMatched, false);
  assert.equal(taps.length, 0);
});

test("followEnsure: missing targetUser → missingTargetUser", async () => {
  const { op } = makeOp({});
  const r = await op.followEnsure({ targetUser: "", doc: doc([root(), avatar("张三")]) });
  assert.equal(r.ok, false);
  assert.equal(r.step, "missingTargetUser");
  assert.equal(r.sent, false);
  assert.equal(r.authorMatched, false);
});

test("followEnsure: targetUser normalized match (whitespace/@)", async () => {
  const beforeDoc = doc([root(), avatar("张三"), ...overlayCta("关注")]);
  const afterDoc = doc([root(), avatar("张三"), ...overlayCta("已关注")]);
  for (const t of ["@张三", " 张三 ", "张三"]) {
    const { op, taps } = makeOp({ afterDoc });
    const r = await op.followEnsure({ targetUser: t, doc: beforeDoc });
    assert.equal(r.ok, true, `targetUser=${JSON.stringify(t)} should match`);
    assert.equal(taps.length, 1);
  }
});