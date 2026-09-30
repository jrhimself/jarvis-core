/**
 * The scratchpad a turn writes its steps on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_ITEMS, renderTodos, TodoList } from "../dist/todo.js";

test("a list is written whole, then merged by id", () => {
  const list = new TodoList();
  list.write(
    [
      { id: "1", content: "Read the agenda" },
      { id: "2", content: "Check the weather" },
    ],
    false,
  );
  const merged = list.write([{ id: "1", status: "done" }, { id: "3", content: "Say it", status: "in_progress" }], true);

  assert.deepEqual(
    merged.map((item) => [item.id, item.status]),
    [
      ["1", "done"],
      ["2", "pending"],
      ["3", "in_progress"],
    ],
  );
  assert.equal(renderTodos(merged), "[x] 1. Read the agenda\n[ ] 2. Check the weather\n[>] 3. Say it\n2 open.");
});

test("writing without merge replaces, and an update to an unknown id with no text is ignored", () => {
  const list = new TodoList();
  list.write([{ id: "1", content: "a" }], false);
  const replaced = list.write([{ id: "9", status: "done" }, { id: "2", content: "b" }], false);
  assert.deepEqual(replaced.map((item) => item.id), ["2"]);
});

test("the list has a ceiling, and an empty one says so", () => {
  const list = new TodoList();
  const many = Array.from({ length: MAX_ITEMS + 10 }, (_, i) => ({ id: String(i), content: "step" }));
  assert.equal(list.write(many, false).length, MAX_ITEMS);
  assert.equal(renderTodos([]), "The list is empty.");
});

test("what is read back is a copy", () => {
  const list = new TodoList();
  list.write([{ id: "1", content: "a" }], false);
  const first = list.read();
  first[0]!.content = "changed";
  assert.equal(list.read()[0]?.content, "a");
});
