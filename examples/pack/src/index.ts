/**
 * The example pack: the smallest thing the loader will start.
 *
 * Copy this directory into `packs/<your-id>` of a core checkout, rename it, and
 * replace the tool. What has to survive the rename is in the README next to
 * this file.
 */

import type { JarvisPack } from "@jarvis/shared";

import { exampleConfig } from "./config.js";
import { createExampleServer, EXAMPLE_SERVER_NAME, EXAMPLE_TOOLS } from "./greet.js";

export type { ExampleConfig } from "./config.js";
export { greeting } from "./greet.js";

/**
 * What the prompt says about this pack, carried by the pack itself.
 *
 * A deployment without this pack does not carry the paragraph, which is the
 * point: the prompt should describe the assistant that actually started, not
 * the one the repository could build. Dutch, like the rest of what is said out
 * loud here.
 */
const PERSONA = `Je kunt iemand groeten met een groet die bij het tijdstip past. Doe dat alleen als
erom gevraagd wordt — een begroeting die niemand vroeg is ruis.`;

const pack: JarvisPack<unknown, unknown> = {
  name: EXAMPLE_SERVER_NAME,

  /** One line, said when somebody asks what this deployment can do. */
  summary: "greets whoever is in the room",

  /**
   * What this pack wants, so core can say why it is off without guessing.
   *
   * `configured()` answers yes or no, which is all the loader needs and nothing
   * anyone can act on. These two fields are what turns "the greeting pack is not
   * configured" into "JARVIS_EXAMPLE_WHO is empty, and it is the name to greet
   * somebody by" -- and core reads the variables itself, so what it reports is
   * measured rather than repeated from here. Name every variable the pack reads;
   * `configured()` stays the authority on whether it runs.
   */
  needs: [{ env: "JARVIS_EXAMPLE_WHO", why: "the name to greet somebody by" }],

  /**
   * Whether this machine has what the pack needs.
   *
   * Read the environment, decide, return. This runs before `create` on every
   * session, so it should not talk to anything: false is the ordinary answer
   * for most packs on most machines, and it is not a failure.
   */
  configured: () => exampleConfig().who !== "",

  /**
   * The context carries the four things a pack may legitimately need, and
   * `display` is the one easiest to miss: it is how a pack puts a window of its
   * own on screen, timed to the sentence being spoken. Taken here and handed to
   * the server, because a tool that wants the screen has to be given it.
   */
  create: (context) => ({
    servers: { [EXAMPLE_SERVER_NAME]: createExampleServer(exampleConfig(), context.display) },
    tools: EXAMPLE_TOOLS,
    persona: PERSONA,

    // No `probes` on purpose. A probe answers "is the thing this pack talks to
    // actually up", and this pack talks to nothing outside the process. A
    // server with no probe is reported healthy without being asked, which is
    // right here and wrong for anything with a dependency: a pack that reaches
    // across the network and skips its probe shows a tick it has not earned.
  }),
};

export default pack;
