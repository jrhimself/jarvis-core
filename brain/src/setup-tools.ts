/**
 * Asking the running process what it is, instead of remembering.
 *
 * The system prompt already carries the deployment record, which is enough for
 * the assistant to stop inventing a house it does not have. It is not enough for
 * "does it work": the prompt is assembled at startup and says which credentials
 * were set, never whether the thing behind them answers. A token that expired an
 * hour ago still reads as configured.
 *
 * So this tool exists, and it returns the same record -- literally the same
 * renderer, so the two can never drift -- with one section the prompt cannot
 * have: every dependency asked, just now, whether it is there. That is the
 * difference between "HA_URL is set" and "the house answered in 41ms", and only
 * the second one is worth saying out loud to someone who is trying to get
 * something working.
 *
 * There is deliberately nothing here that changes anything. Installing a pack
 * means editing a manifest, fetching a repository, writing a secret into an env
 * file and restarting the service, and every one of those is a person's job on
 * purpose. What the assistant can do is say precisely which of the four is
 * missing, which is what it was asked for.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

import { deploymentBlock, type Deployment } from "./deployment.js";
import type { HealthCheck } from "./health.js";

export const SETUP_SERVER_NAME = "setup";
export const SETUP_TOOLS = [`mcp__${SETUP_SERVER_NAME}__*`];

/** One probe result as a line, with what answered or what did not. */
function checkLine(check: HealthCheck): string {
  const who = check.pack === true ? `${check.server} (pack)` : check.server;
  const took = check.ms === undefined ? "" : ` in ${check.ms}ms`;
  switch (check.state) {
    case "ok":
      return `- ${who}: answered${took} -- ${check.detail}`;
    case "down":
      return `- ${who}: DID NOT ANSWER${took} -- ${check.detail}`;
    default:
      return `- ${who}: switched off -- ${check.detail}`;
  }
}

/**
 * The setup tool server.
 *
 * The record is passed in rather than built here: it describes the session that
 * is running, and one assembled at call time would describe a different set of
 * packs than the tools the model can actually see.
 */
export function createSetupServer(
  deployment: Deployment,
  probe: () => Promise<readonly HealthCheck[]>,
) {
  const describe = tool(
    "my_setup",
    "How this deployment is really built, measured now: which packs are installed, " +
      "running, off or not packs at all; what each one that is off is still missing; " +
      "what core itself can and cannot reach; and every dependency asked this second " +
      "whether it answers. Call it before answering anything about what you can do, " +
      "what is connected, what is installed, or what someone must do to get a " +
      "capability working -- including when you think you already know. Being sure is " +
      "how you end up telling someone the house is connected while the screen says it " +
      "is not.",
    {},
    async () => {
      let live: string[];
      try {
        const checks = await probe();
        live =
          checks.length === 0
            ? ["Nothing to ask: no server on this deployment has anything outside this process."]
            : checks.map(checkLine);
      } catch (error) {
        // A failed probe run is itself an answer, and a better one than silence:
        // "I could not check" is true, "everything is fine" would not be.
        live = [
          `The check itself failed, so nothing below was verified: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ];
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              deploymentBlock(deployment),
              "",
              "### Asked just now, this second",
              "",
              ...live,
              "",
              "A server that did not answer is configured but unreachable, which is a different",
              "problem from one that was never set up: say which of the two it is.",
            ].join("\n"),
          },
        ],
      };
    },
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  return createSdkMcpServer({
    name: SETUP_SERVER_NAME,
    version: "1.0.0",
    tools: [describe],
  });
}
