import test from "node:test";
import assert from "node:assert/strict";

import { PROCESSING_EMOJI, withProcessingReaction } from "../src/processing-reaction.mjs";

test("attachment processing adds Typing to the source message and removes it after reply", async () => {
  const steps = [];
  const runJson = async args => {
    steps.push(args[2]);
    if (args[2] === "create") {
      assert.deepEqual(JSON.parse(args[4]), { message_id: "om_source" });
      assert.deepEqual(JSON.parse(args[6]), { reaction_type: { emoji_type: PROCESSING_EMOJI } });
      return { reaction_id: "reaction-1" };
    }
    assert.deepEqual(JSON.parse(args[4]), { message_id: "om_source", reaction_id: "reaction-1" });
    return {};
  };
  const result = await withProcessingReaction({
    messageId: "om_source", runJson,
    onAdded: async () => steps.push("saved"),
    work: async () => { steps.push("reply"); return "done"; },
    onRemoved: async () => steps.push("cleared"),
  });
  assert.equal(result, "done");
  assert.deepEqual(steps, ["create", "saved", "reply", "delete", "cleared"]);
});

test("processing failure still removes the reaction", async () => {
  const steps = [];
  await assert.rejects(
    withProcessingReaction({
      messageId: "om_source",
      runJson: async args => {
        steps.push(args[2]);
        return args[2] === "create" ? { reaction_id: "reaction-1" } : {};
      },
      work: async () => { throw new Error("recognition failed"); },
    }),
    /recognition failed/,
  );
  assert.deepEqual(steps, ["create", "delete"]);
});

test("reaction permission failure does not block the original attachment flow", async () => {
  const errors = [];
  const result = await withProcessingReaction({
    messageId: "om_source",
    runJson: async () => { throw new Error("no scope"); },
    work: async () => "card sent",
    onError: (stage, error) => errors.push([stage, error.message]),
  });
  assert.equal(result, "card sent");
  assert.deepEqual(errors, [["add", "no scope"]]);
});

test("failed removal remains recorded for startup cleanup", async () => {
  const steps = [];
  await withProcessingReaction({
    messageId: "om_source",
    runJson: async args => {
      if (args[2] === "create") return { reaction_id: "reaction-1" };
      throw new Error("temporary delete failure");
    },
    onAdded: async () => steps.push("saved"),
    onRemoved: async () => steps.push("cleared"),
    onError: stage => steps.push(stage),
    work: async () => {},
  });
  assert.deepEqual(steps, ["saved", "remove"]);
});
