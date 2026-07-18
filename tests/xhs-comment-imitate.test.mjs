import test from "node:test";
import assert from "node:assert/strict";

import {
  callGateway, readComments, topByLikes, imitate, buildImitatePrompt,
  postComment, runCommentImitate,
} from "../scripts/xhs-comment-imitate.mjs";
import { buildConfirmCard } from "../scripts/xhs-lark-notifier.mjs";

// ---- helpers ----------------------------------------------------------------

function makeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

const HEX64 = "a".repeat(64);

function mockTransport({ gateway = {}, cpa } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const entry = { url, method: init.method, body: init.body ? JSON.parse(init.body) : null };
    calls.push(entry);
    if (url.endsWith("/v1/chat/completions")) {
      if (cpa instanceof Error) throw cpa;
      if (typeof cpa === "function") return makeResponse(cpa(entry.body, calls));
      return makeResponse({
        choices: [{ message: { content: cpa ?? "好喜欢这种风格" } }],
      });
    }
    if (url.endsWith("/v1/command")) {
      const command = entry.body.command;
      const handler = gateway[command];
      if (typeof handler === "function") return makeResponse(handler(entry.body, calls));
      if (handler && typeof handler === "object") return makeResponse(handler);
      if (command) return makeResponse({ status: "verified", machine: entry.body.machine });
      return makeResponse({ ok: false, error: "not_found" }, 404);
    }
    return makeResponse({ ok: false, error: "not_found" }, 404);
  };
  return { fetch, calls };
}

function fakeNotifier(verdict) {
  return { sendConfirm: async () => verdict };
}

const sampleComments = [
  { author: "小红", content: "太好看了吧", likes: 99, isPinned: false, hasTranslate: false },
  { author: "大伟", content: "求链接求链接", likes: 7, isPinned: false, hasTranslate: false },
  { author: "作者", content: "置顶：感谢关注", likes: null, isPinned: true, hasTranslate: false },
  { author: "阿明", content: "已收藏", likes: 230, isPinned: false, hasTranslate: true },
];

function gatewayOk() {
  return {
    "xhs.comments.read": { status: "verified", comments: sampleComments, commentCount: sampleComments.length },
    "xhs.comment.open": {
      status: "verified", commentCount: 5,
      target: { title: "今日穿搭", author: "博主A", mediaType: "image" },
      editorStateHash: HEX64,
    },
    "xhs.comment.input": { status: "verified", inputMethod: "shortcut", draftLength: 8 },
    "xhs.comment.send": { status: "verified", beforeCount: 5, afterCount: 6 },
  };
}

// ---- tests ------------------------------------------------------------------

test("topByLikes sorts by likes desc and takes top N (null likes sorts last)", () => {
  const top = topByLikes(sampleComments, 3);
  assert.equal(top.length, 3);
  assert.equal(top[0].author, "阿明");
  assert.equal(top[1].author, "小红");
  assert.equal(top[2].author, "大伟");
  // 置顶评论 likes=null 排到 3 名外
  assert.ok(!top.some((c) => c.isPinned));
});

test("topByLikes rejects bad n", () => {
  assert.throws(() => topByLikes([], 0));
  assert.throws(() => topByLikes([], 51));
  assert.throws(() => topByLikes("x"));
});

test("buildImitatePrompt includes each author + content and the 20-char constraint", () => {
  const prompt = buildImitatePrompt(sampleComments.slice(0, 2));
  assert.match(prompt, /小红/);
  assert.match(prompt, /太好看了吧/);
  assert.match(prompt, /20/);
  assert.throws(() => buildImitatePrompt([]));
});

test("imitate posts to CPA /v1/chat/completions and returns trimmed content", async () => {
  const { fetch, calls } = mockTransport({ cpa: "  好喜欢这种风格  " });
  const text = await imitate(sampleComments.slice(0, 3), { fetch, model: "gpt-5.4" });
  assert.equal(text, "好喜欢这种风格");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/chat\/completions$/);
  assert.equal(calls[0].body.model, "gpt-5.4");
  assert.match(calls[0].body.messages[0].content, /小红/);
});

test("imitate throws on non-ok CPA response", async () => {
  const { fetch } = mockTransport({ cpa: new Error("boom") });
  await assert.rejects(() => imitate(sampleComments.slice(0, 1), { fetch }));
});

test("callGateway throws on http error with gateway error detail", async () => {
  const fetch = async () => makeResponse({ ok: false, error: "device_offline" }, 503);
  await assert.rejects(
    () => callGateway("xhs.comments.read", { machine: "01" }, { fetch }),
    /device_offline/,
  );
});

test("postComment chains open → input → send with correct hash/count/target plumbing", async () => {
  const { fetch, calls } = mockTransport({ gateway: gatewayOk() });
  await postComment("01", "好喜欢", { expectedEmptyEditorStateHash: HEX64 }, { fetch });
  const commands = calls.map((c) => c.body.command);
  assert.deepEqual(commands, ["xhs.comment.open", "xhs.comment.input", "xhs.comment.send"]);
  const input = calls[1].body;
  assert.equal(input.expectedEditorStateHash, HEX64);
  assert.equal(input.text, "好喜欢");
  const send = calls[2].body;
  assert.equal(send.expectedDraft, "好喜欢");
  assert.equal(send.expectedBeforeCount, 5);
  assert.deepEqual(send.expectedTarget, { title: "今日穿搭", author: "博主A", mediaType: "image" });
  assert.equal(send.expectedEmptyEditorStateHash, HEX64);
});

test("postComment rejects bad expectedEmptyEditorStateHash", async () => {
  const { fetch } = mockTransport({ gateway: gatewayOk() });
  await assert.rejects(() => postComment("01", "x", { expectedEmptyEditorStateHash: "nothex" }, { fetch }));
  await assert.rejects(() => postComment("01", "x", {}, { fetch }));
});

test("runCommentImitate confirmed path sends comment and returns outcome=sent", async () => {
  const { fetch, calls } = mockTransport({ gateway: gatewayOk(), cpa: "种草了" });
  const result = await runCommentImitate(
    { machine: "01", topN: 3, notifier: fakeNotifier({ decision: "send", text: null, reason: "confirmed" }),
      sendContext: { expectedEmptyEditorStateHash: HEX64 } },
    { fetch },
  );
  assert.equal(result.outcome, "sent");
  assert.equal(result.sent, true);
  assert.equal(result.text, "种草了");
  assert.equal(result.reason, "confirmed");
  const commands = calls.map((c) => c.body.command).filter((c) => typeof c === "string");
  assert.deepEqual(commands, ["xhs.comments.read", "xhs.comment.open", "xhs.comment.input", "xhs.comment.send"]);
  // CPA call happens between comments.read and comment.open
  const cpaCall = calls.find((c) => c.url.endsWith("/v1/chat/completions"));
  assert.ok(cpaCall, "CPA imitate call should happen");
  const cpaIndex = calls.indexOf(cpaCall);
  assert.equal(calls[cpaIndex - 1].body.command, "xhs.comments.read");
  assert.equal(calls[cpaIndex + 1].body.command, "xhs.comment.open");
});

test("runCommentImitate rewritten verdict sends the rewritten text, not candidate", async () => {
  const { fetch, calls } = mockTransport({ gateway: gatewayOk(), cpa: "原始候选" });
  const result = await runCommentImitate(
    { machine: "02", notifier: fakeNotifier({ decision: "send", text: "用户改写的文本", reason: "rewritten" }),
      sendContext: { expectedEmptyEditorStateHash: HEX64 } },
    { fetch },
  );
  assert.equal(result.outcome, "sent");
  assert.equal(result.text, "用户改写的文本");
  // input 命令用的是改写文本
  const inputCall = calls.find((c) => c.body.command === "xhs.comment.input");
  assert.equal(inputCall.body.text, "用户改写的文本");
});

test("runCommentImitate rejected verdict does not send", async () => {
  const { fetch, calls } = mockTransport({ gateway: gatewayOk(), cpa: "候选" });
  const result = await runCommentImitate(
    { machine: "01", notifier: fakeNotifier({ decision: "skip", text: null, reason: "rejected" }),
      sendContext: { expectedEmptyEditorStateHash: HEX64 } },
    { fetch },
  );
  assert.equal(result.outcome, "skipped");
  assert.equal(result.sent, false);
  assert.equal(result.reason, "rejected");
  const commands = calls.map((c) => c.body.command).filter(Boolean);
  // 只有 comments.read + cpa，无 open/input/send
  assert.ok(!commands.includes("xhs.comment.send"));
  assert.ok(!commands.includes("xhs.comment.open"));
});

test("runCommentImitate timeout verdict skips and does not send", async () => {
  const { fetch, calls } = mockTransport({ gateway: gatewayOk(), cpa: "候选" });
  const result = await runCommentImitate(
    { machine: "01", notifier: fakeNotifier({ decision: "skip", text: null, reason: "timeout" }),
      sendContext: { expectedEmptyEditorStateHash: HEX64 } },
    { fetch },
  );
  assert.equal(result.outcome, "skipped");
  assert.equal(result.reason, "timeout");
  const commands = calls.map((c) => c.body.command).filter(Boolean);
  assert.ok(!commands.includes("xhs.comment.send"));
});

test("runCommentImitate returns no_comments when panel empty", async () => {
  const { fetch } = mockTransport({
    gateway: { "xhs.comments.read": { status: "verified", comments: [], commentCount: 0 } },
    cpa: "x",
  });
  const result = await runCommentImitate(
    { machine: "01", notifier: fakeNotifier({ decision: "send", text: null, reason: "confirmed" }) },
    { fetch },
  );
  assert.equal(result.outcome, "no_comments");
  assert.equal(result.sent, false);
});

test("runCommentImitate requires a notifier", async () => {
  const { fetch } = mockTransport({ gateway: gatewayOk(), cpa: "x" });
  await assert.rejects(() => runCommentImitate({ machine: "01" }, { fetch }), /notifier/);
});

test("runCommentImitate rejects bad machine", async () => {
  const { fetch } = mockTransport({ gateway: gatewayOk(), cpa: "x" });
  await assert.rejects(() => runCommentImitate({ machine: "1", notifier: fakeNotifier({}) }, { fetch }), /machine/);
});

test("buildConfirmCard produces Card 2.0 with callback buttons tagged by request_id", () => {
  const card = buildConfirmCard({
    machine: "01", sourceComments: sampleComments.slice(0, 2),
    candidate: "种草了", requestId: "req-abc", timeoutMs: 300_000,
  });
  assert.equal(card.schema, "2.0");
  assert.ok(card.header);
  assert.ok(Array.isArray(card.body));
  const buttons = card.body.flatMap((el) =>
    (el.columns ?? []).flatMap((col) => col.elements.filter((e) => e.tag === "button")));
  assert.equal(buttons.length, 2);
  const actions = buttons.map((b) => b.behaviors[0].value.action);
  assert.ok(actions.includes("confirm"));
  assert.ok(actions.includes("reject"));
  for (const b of buttons) {
    assert.equal(b.behaviors[0].value.request_id, "req-abc");
    assert.equal(b.behaviors[0].type, "callback");
  }
  // markdown 里含候选 + 超时提示
  const md = card.body.find((el) => el.tag === "markdown");
  assert.match(md.content, /种草了/);
  assert.match(md.content, /超时/);
});

test("buildConfirmCard rejects missing requestId", () => {
  assert.throws(() => buildConfirmCard({ machine: "01", sourceComments: [], candidate: "x", timeoutMs: 1000 }));
});