// fixture 测试：xhs.follow.ensure 的解析与流程（req#9：四状态、desc-only、错误目标、按钮缺失）。
// fast-operator 的节点 idiom：doc.nodes[i] = {text, contentDesc, className, bounds:[L,T,R,B], clickable, ...}
// helpers（profileOverlayOpen / profileAuthor / findFollowBtn）只读 doc + centerOf(bounds)，不碰 session。
// followEnsure 流程靠 stub 掉 dump/tap/currentFocus/backFromProfile/pace/metricsSummary 在 fixture 层验证。
import assert from "node:assert/strict";
import test from "node:test";
import { FastOperator } from "../scripts/fast-operator.mjs";

// 合成节点。center = [(L+R)/2, (T+B)/2]（与 fast-operator.centerOf 一致）。
function node({ text = "", desc = "", cls = "android.widget.TextView", bounds = [0, 0, 100, 100], clickable = false } = {}) {
  return { text, contentDesc: desc, className: cls, bounds, clickable };
}
const doc = (nodes, extra = {}) => ({ nodes, _dumpMs: 1, _label: "test", ...extra });

// 主页浮层信号：clickable ImageView + contentDesc + y<600（头像）。
function avatar(name, bounds = [40, 100, 200, 260]) {
  return node({ desc: `头像,${name}`, cls: "android.widget.ImageView", bounds, clickable: true });
}
// 关注按钮：clickable Button/TextView，y<900。
function followBtn(label, { via = "text", bounds = [800, 150, 1000, 210], cls = "android.widget.Button" } = {}) {
  return node({
    text: via === "text" ? label : "",
    desc: via === "desc" ? label : "",
    cls,
    bounds,
    clickable: true,
  });
}

// stub 出一个只跑解析+流程、无设备的 operator。afterDoc 控制 tap 后重 dump 的结果。
function makeOp({ afterDoc = null } = {}) {
  const op = new FastOperator({});
  const taps = [];
  op.currentFocus = async () => ({ activity: "NoteDetailActivity" });
  op.pace = async () => {};
  op.tap = async (x, y) => { taps.push([x, y]); return { ok: true }; };
  op.dump = async (opts) => afterDoc ?? doc([], { _label: opts?.label });
  op.backFromProfile = async (n) => ({ back: n });
  op.metricsSummary = () => ({ actions: 0 });
  return { op, taps };
}

// ---------- 纯解析：findFollowBtn 四状态 + desc-only + 缺失 + 假阳排除 ----------
test("findFollowBtn classifies the four follow states (text and desc separately)", () => {
  const op = new FastOperator({});
  const at = (label, via = "text") => doc([followBtn(label, { via })]);
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
  assert.equal(op.findFollowBtn(doc([followBtn("评论", { via: "text" })])), null);
  assert.equal(op.findFollowBtn(doc([])), null);
});

test("findFollowBtn rejects false-positive labels like 关注的话题 (exact-set, not includes)", () => {
  const op = new FastOperator({});
  // “关注的话题” 不应被 includes 误中；exact-set 等值把关
  assert.equal(op.findFollowBtn(doc([followBtn("关注的话题")]).nodes.length ? doc([followBtn("关注的话题")]) : doc([])), null);
  assert.equal(op.findFollowBtn(doc([node({ text: "关注的话题", cls: "android.widget.TextView", bounds: [800, 150, 1000, 210], clickable: true })])), null);
  // 但同屏有真“关注”按钮仍能命中
  const mixed = doc([
    node({ text: "关注的话题", cls: "android.widget.TextView", bounds: [100, 150, 400, 210], clickable: true }),
    followBtn("关注"),
  ]);
  assert.equal(op.findFollowBtn(mixed).state, "not_followed");
});

// ---------- 纯解析：profileOverlayOpen + profileAuthor ----------
test("profileOverlayOpen detects the overlay signal (clickable ImageView + desc + y<600)", () => {
  const op = new FastOperator({});
  assert.equal(op.profileOverlayOpen(doc([avatar("张三")])), true);
  // y>=600 不算浮层头像
  assert.equal(op.profileOverlayOpen(doc([avatar("张三", [40, 700, 200, 860])])), false);
  // 非 clickable 或无 contentDesc 不算
  assert.equal(op.profileOverlayOpen(doc([node({ desc: "头像,张三", cls: "android.widget.ImageView", bounds: [40, 100, 200, 260], clickable: false })])), false);
  assert.equal(op.profileOverlayOpen(doc([node({ cls: "android.widget.ImageView", bounds: [40, 100, 200, 260], clickable: true })])), false);
  assert.equal(op.profileOverlayOpen(doc([])), false);
});

test("profileAuthor tier-1 extracts name from 头像,<name>; tier-1 miss returns name:null + fallback", () => {
  const op = new FastOperator({});
  // tier-1 命中
  assert.deepEqual(op.profileAuthor(doc([avatar("张三")])), { name: "张三", fallback: null });
  // 名字含逗号也只取“头像,”之后整体
  assert.equal(op.profileAuthor(doc([avatar("张三,二店")])).name, "张三,二店");
  // tier-1 miss（无头像 desc）→ name:null；fallback 取顶部非 meta TextView
  const noAvatar = doc([
    node({ text: "李四", cls: "android.widget.TextView", bounds: [300, 120, 600, 170], clickable: false }),
    node({ text: "粉丝 123", cls: "android.widget.TextView", bounds: [300, 180, 600, 230], clickable: false }),
  ]);
  const r = op.profileAuthor(noAvatar);
  assert.equal(r.name, null);
  assert.equal(r.fallback, "李四");
  // 全空 → 都 null
  assert.deepEqual(op.profileAuthor(doc([])), { name: null, fallback: null });
});

// ---------- 流程：followEnsure（stub 掉设备 IO）----------
test("followEnsure: not_followed → tap → followed (ok, one tap)", async () => {
  const beforeDoc = doc([avatar("张三"), followBtn("关注")]);
  const afterDoc = doc([avatar("张三"), followBtn("已关注")]);
  const { op, taps } = makeOp({ afterDoc });
  const r = await op.followEnsure({ targetUser: "张三", doc: beforeDoc });
  assert.equal(r.ok, true);
  assert.equal(r.step, "followed");
  assert.equal(r.beforeState, "not_followed");
  assert.equal(r.afterState, "followed");
  assert.equal(r.verified, true);
  assert.equal(r.sent, true); // 已 tap：关注已发出
  assert.equal(r.authorMatched, true);
  assert.equal(taps.length, 1);
  assert.equal(r.targetUser, "张三");
  assert.equal(r.extractedAuthor, "张三");
});

test("followEnsure: already followed → idempotent skip, NO tap", async () => {
  const beforeDoc = doc([avatar("张三"), followBtn("已关注")]);
  const { op, taps } = makeOp({ afterDoc: doc([avatar("张三"), followBtn("已关注")]) });
  const r = await op.followEnsure({ targetUser: "张三", doc: beforeDoc });
  assert.equal(r.ok, true);
  assert.equal(r.step, "already_followed");
  assert.equal(r.beforeState, "followed");
  assert.equal(r.afterState, "followed");
  assert.equal(r.sent, false); // 未 tap
  assert.equal(r.authorMatched, true);
  assert.equal(taps.length, 0); // 幂等：不重复点击
});

test("followEnsure: wrong target (author=张三, targetUser=李四) → authorMismatch, fail-closed, NO tap", async () => {
  const beforeDoc = doc([avatar("张三"), followBtn("关注")]);
  const { op, taps } = makeOp({ afterDoc: doc([avatar("张三"), followBtn("已关注")]) });
  const r = await op.followEnsure({ targetUser: "李四", doc: beforeDoc });
  assert.equal(r.ok, false);
  assert.equal(r.step, "authorMismatch");
  assert.equal(r.sent, false); // tap 前守卫：未发出
  assert.equal(r.authorMatched, false);
  assert.equal(r.extractedAuthor, "张三");
  assert.equal(taps.length, 0); // fail-closed：作者不匹配绝不 tap
});

test("followEnsure: normalize collision safety — a-b≠ab, 张·三≠张三 (fail-closed, NO tap)", async () => {
  // 旧 norm 删内部 _/-/·/空格 → a-b==ab 会放行错误目标（R2 阻断）。
  // 新 norm 只做 NFKC+trim+strip@，保留内部标点 → 不匹配 → authorMismatch 不 tap。
  const op = new FastOperator({});
  const r1 = await op.followEnsure({ targetUser: "ab", doc: doc([avatar("a-b"), followBtn("关注")]) });
  assert.equal(r1.step, "authorMismatch");
  assert.equal(r1.sent, false);
  assert.equal(r1.authorMatched, false);
  const r2 = await op.followEnsure({ targetUser: "张三", doc: doc([avatar("张·三"), followBtn("关注")]) });
  assert.equal(r2.step, "authorMismatch");
  assert.equal(r2.authorMatched, false);
});

test("followEnsure: author unreadable (overlay open but avatar desc format unknown) → authorMismatch, fail-closed, NO tap", async () => {
  // 浮层在（clickable ImageView + desc + y<600 通过 profileOverlayOpen），但头像 desc 不是「头像,<name>」
  // → tier-1 miss → name:null → authorMismatch。这正是「头像,<name> 格式未实证」风险下的 fail-closed 行为。
  const beforeDoc = doc([
    node({ desc: "背景图", cls: "android.widget.ImageView", bounds: [40, 100, 200, 260], clickable: true }),
    followBtn("关注"),
  ]);
  const { op, taps } = makeOp({ afterDoc: doc([followBtn("已关注")]) });
  const r = await op.followEnsure({ targetUser: "张三", doc: beforeDoc });
  assert.equal(r.ok, false);
  assert.equal(r.step, "authorMismatch");
  assert.equal(taps.length, 0);
});

test("followEnsure: follow button missing (author matches) → followBtnNotFound, NO tap", async () => {
  const beforeDoc = doc([avatar("张三")]); // 无关注按钮
  const { op, taps } = makeOp({ afterDoc: doc([avatar("张三"), followBtn("已关注")]) });
  const r = await op.followEnsure({ targetUser: "张三", doc: beforeDoc });
  assert.equal(r.ok, false);
  assert.equal(r.step, "followBtnNotFound");
  assert.equal(r.sent, false); // tap 前守卫
  assert.equal(r.authorMatched, true);
  assert.equal(taps.length, 0);
});

test("followEnsure: afterState empty after tap → not success (req#7), sent=true (ambiguous, NOT notSent)", async () => {
  const beforeDoc = doc([avatar("张三"), followBtn("关注")]);
  const afterDoc = doc([avatar("张三")]); // tap 后按钮丢失，afterState=""
  const { op, taps } = makeOp({ afterDoc });
  const r = await op.followEnsure({ targetUser: "张三", doc: beforeDoc });
  assert.equal(r.ok, false);
  assert.equal(r.step, "afterStateUnknown");
  assert.equal(r.afterState, "");
  assert.equal(r.verified, false);
  assert.equal(r.sent, true); // 已 tap：关注已发出，结果未确认 → ambiguous，绝不可标 notSent
  assert.equal(r.authorMatched, true);
  assert.equal(taps.length, 1); // tap 发生了，但未验证为成功
});

test("followEnsure: not on profile overlay → notOnProfileOverlay, NO tap", async () => {
  const beforeDoc = doc([followBtn("关注")]); // 无浮层头像信号
  const { op, taps } = makeOp({ afterDoc: doc([followBtn("已关注")]) });
  const r = await op.followEnsure({ targetUser: "张三", doc: beforeDoc });
  assert.equal(r.ok, false);
  assert.equal(r.step, "notOnProfileOverlay");
  assert.equal(r.sent, false); // tap 前守卫
  assert.equal(r.authorMatched, false);
  assert.equal(taps.length, 0);
});

test("followEnsure: missing targetUser → missingTargetUser", async () => {
  const { op } = makeOp({});
  const r = await op.followEnsure({ targetUser: "", doc: doc([avatar("张三")]) });
  assert.equal(r.ok, false);
  assert.equal(r.step, "missingTargetUser");
  assert.equal(r.sent, false);
  assert.equal(r.authorMatched, false);
});

test("followEnsure: targetUser normalized match (whitespace/@/case-insensitive)", async () => {
  // @张三 / " 张三 " / "张三" 应等价
  const beforeDoc = doc([avatar("张三"), followBtn("关注")]);
  const afterDoc = doc([avatar("张三"), followBtn("已关注")]);
  for (const t of ["@张三", " 张三 ", "张三"]) {
    const { op, taps } = makeOp({ afterDoc });
    const r = await op.followEnsure({ targetUser: t, doc: beforeDoc });
    assert.equal(r.ok, true, `targetUser=${JSON.stringify(t)} should match`);
    assert.equal(taps.length, 1);
  }
});