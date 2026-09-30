/**
 * A list to work through, kept while one question is being answered.
 *
 * The slow turns are the ones with seven or eight tool calls in a row, and
 * what makes them slow is often that the model finds out what the next call
 * should be one call at a time. Writing the steps down first is cheap, and it
 * makes the ones that were not needed visible before they are made.
 *
 * Per session and in memory: this is a scratchpad for a turn, not a to-do
 * list for the household. Anything that has to outlive the conversation is a
 * scheduled job or a fact.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const TODO_SERVER_NAME = "todo";
export const TODO_TOOLS = [`mcp__${TODO_SERVER_NAME}__*`];

const STATUS = z.enum(["pending", "in_progress", "done", "dropped"]);
export type TodoStatus = z.infer<typeof STATUS>;

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/** More than this is a project, and a project is not a scratchpad. */
export const MAX_ITEMS = 30;
const MAX_CONTENT = 300;

const MARK: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[>]", done: "[x]", dropped: "[~]" };

export class TodoList {
  #items: TodoItem[] = [];

  /** Replaces the list, or with `merge` updates items by id and appends new ones. */
  write(items: ReadonlyArray<{ id: string; content?: string | undefined; status?: TodoStatus | undefined }>, merge: boolean): TodoItem[] {
    if (!merge) {
      this.#items = [];
    }
    for (const item of items) {
      const existing = this.#items.find((entry) => entry.id === item.id);
      if (existing !== undefined) {
        if (item.content !== undefined) existing.content = item.content.slice(0, MAX_CONTENT);
        if (item.status !== undefined) existing.status = item.status;
      } else if (item.content !== undefined) {
        this.#items.push({ id: item.id, content: item.content.slice(0, MAX_CONTENT), status: item.status ?? "pending" });
      }
    }
    this.#items = this.#items.slice(0, MAX_ITEMS);
    return this.read();
  }

  read(): TodoItem[] {
    return this.#items.map((item) => ({ ...item }));
  }
}

export function renderTodos(items: readonly TodoItem[]): string {
  if (items.length === 0) return "The list is empty.";
  const open = items.filter((item) => item.status === "pending" || item.status === "in_progress").length;
  return [...items.map((item) => `${MARK[item.status]} ${item.id}. ${item.content}`), `${open} open.`].join("\n");
}

export function createTodoServer(list: TodoList) {
  const todo = tool(
    "todo",
    "Write down the steps of a question that will take several tool calls, and tick them off as you " +
      "go. Use it when the answer needs three or more separate lookups; skip it for anything a single " +
      "tool answers. Send `items` to write (the whole list, or with merge=true only the ones that " +
      "changed); send nothing to read the list back. Keep one item in_progress at a time, and mark an " +
      "item dropped when you find it is not needed. The list is yours: never read it out or mention it.",
    {
      items: z
        .array(
          z.object({
            id: z.string().min(1).max(20).describe("Short id, like '1' or 'weather'"),
            content: z.string().max(MAX_CONTENT).optional(),
            status: STATUS.optional(),
          }),
        )
        .max(MAX_ITEMS)
        .optional(),
      merge: z.boolean().default(false).describe("Update the listed items only, keep the rest"),
    },
    async (args) => {
      const items = args.items === undefined ? list.read() : list.write(args.items, args.merge);
      return { content: [{ type: "text" as const, text: renderTodos(items) }] };
    },
    { annotations: { readOnlyHint: false } },
  );

  return createSdkMcpServer({ name: TODO_SERVER_NAME, version: "1.0.0", tools: [todo] });
}
