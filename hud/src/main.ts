/**
 * Entry point for the HUD workspace.
 *
 * Empty, and deliberately so for now. The page that actually runs is
 * `hud/public/index.html`: one self-contained file, styles and script inline,
 * which is what lets it be opened straight off the static server with nothing
 * built and nothing bundled. For a front-end this size that is worth more than
 * a module graph.
 *
 * The workspace stays because it is where that file gets taken apart when it
 * has earned it -- the orb, the transcript, the display surface and the voice
 * scheduling are four independent things sharing one scope today. Anything
 * added here is compiled into `hud/dist` and would have to be loaded by the
 * page explicitly; nothing does yet.
 */
export {};
