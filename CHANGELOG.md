# Changelog

Notable changes to JARVIS. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

This log starts where the public repository does. JARVIS was built inside one household over
several months before that, and the record of those months -- the changelog entries and the
decision log they refer to by number -- is written against that house: its devices, its rooms,
its counts, the machines it runs on and the systems only that household has. Generalising it
would have left prose that claimed to be about nothing in particular while still describing
somewhere in particular, so it stayed behind with the packs it describes.

What that history produced is the code in this repository, and the shape of it is documented
rather than narrated: [README](README.md) for what it is and how it learns,
[docs/architecture.md](docs/architecture.md) for how the pieces fit, and
[docs/operations.md](docs/operations.md) for running it.

## [Unreleased]

### Added

- `JARVIS_CREDENTIAL_EXPIRY` lists when the deployment's credentials run out, as
  `name=YYYY-MM-DD` pairs. The hourly self check reports `invariant:expiry:<name>` from
  thirty days before, says how long ago once it has passed, and reports a date it cannot
  read rather than going quiet. Meant for tokens that carry no readable expiry, such as a
  long-lived model token, where the date is whatever was written down when it was minted.

## [1.2.0] - 2026-09-21

### Added

- `JARVIS_SPEECH_LANG` says which language the deployment speaks and listens in, `nl`
  (the default, and what every one of these places used to be fixed at) or `en`. It picks
  the voice an answer is read with, the language the microphone is transcribed as, the
  language the acknowledgement lines are recorded in, and what a line put through `say`
  is spoken in when the caller names none. A single line can still ask for the other
  language, which is what the wake-up greeting does. The HUD reads the setting from
  `/api/config`, so the browser's own recogniser and its fallback voice follow it too.

### Changed

- The echo on the voice belongs to the system lines rather than to English. It was
  chosen because the greeting and the tour are written in English and an answer was
  always Dutch, which stopped being true the moment the language became a setting: a
  deployment that speaks English would have echoed every word it said.

## [1.1.0] - 2026-09-18

### Added

- Every version that lands on main is released. A workflow runs after a green acceptance suite,
  reads the version from `package.json`, and when no tag carries it yet creates the tag and a
  GitHub release whose notes are that version's section of this file, word for word. A push that
  leaves the version alone releases nothing; a version without a section here fails the job
  rather than publish an empty release. The host keeps deciding what it runs, as before, but it
  can now follow a tag rather than the tip of main: `jarvis-deploy v1.1.0` is a deploy, and the
  previous tag is the rollback.

## [1.0.0] - 2026-09-18

The first public release. The repository this is published from begins with a single commit:
the history before it was written inside one household and stayed there, as the note above
says. Nothing in the code changed between 0.27.0 and this version. The number changed because
publishing is the moment the shape of a pack, the house seam and the websocket protocol become
things other people build against, and a major version is a promise about exactly that.

### Fixed

- The ignore rules for `packs` and `config` are anchored to the repository root. Unanchored,
  `packs` also matched `brain/src/packs/`, the loader that reads the packs, which was only ever
  tracked because it had been added by force; a fresh checkout of the same tree left it behind.

## [0.27.0] - 2026-09-16

### Added

- The lines that fill a silence are recorded once. "Momentje." was synthesised every time it was
  needed, a second at best and three under the latency mode that gets Dutch stress right, and the
  first sentence of the answer then queued behind it on the same socket. At startup the brain now
  speaks each configured line once through the configured voice and keeps the audio under
  `data/voice-lines/`, keyed on provider, model, voice, speed, language and words; a slow turn
  plays it from disk the moment it is due, through the same path the voice's own audio takes, and
  the socket is free for the answer. A line that could not be recorded is spoken live, as before.

## [0.26.2] - 2026-09-16

### Fixed

- The reset hour says which part of which day. "2 uur" heard at eleven in the morning is two in
  the afternoon to anyone listening. It is now "2 uur vannacht", "9 uur morgenochtend", "3 uur 30
  vanmiddag", on the twelve-hour clock, and "zaterdag 2 uur 's nachts" beyond a day. English gets
  "2:00 AM tonight" and the like.

## [0.26.1] - 2026-09-16

### Fixed

- The page no longer reads the first sentence before the voice does. A turn the model answers at
  once -- a spent plan is answered in a second -- put its text on the page before the voice's
  socket was up, the browser began reading it, and the voice then read all of it again from the
  start. Text for the screen is now held until the page has been told whether the brain speaks
  this turn, which is the half second the socket takes; the model and the voice are not held.
- The reset hour is said the way a person says it. "2:00" was read as two digits by every voice
  tried; in Dutch it is now "2 uur", or "2 uur 30", and other languages get the twelve-hour clock
  with its suffix.
- A fixed line with several sentences is flushed to Fish sentence by sentence, so under `normal`
  latency the first is heard while the rest is still being made, rather than all of it after all
  of it.

## [0.26.0] - 2026-09-16

### Added

- The plan, on the HUD and in the model's ear. The assistant runs on a claude.ai subscription
  metered in two windows, five hours and seven days, and until now the first anyone heard of one
  filling up was the model reading the SDK's own English line about weekly limits aloud, time
  zone in brackets and all, followed by a line to fill the silence. `brain/src/plan.ts` keeps what the SDK says about
  the windows -- the `rate_limit_event` on every call, and the structured usage report when the
  token may ask for it -- and hands it to every open page as a `usage` message. The HUD's new Plan
  pill shows both windows as percentages, or the binding one when only that is known, amber past
  eighty and red when spent, with the reset times in the tooltip. From `JARVIS_PLAN_WARN_PCT` (75)
  onwards each question is prefaced with one line telling the model where the window stands, to
  economise, and never to mention it. And when the plan is spent the SDK's line is not spoken:
  `JARVIS_LIMIT_SENTENCE` is, with `{reset}` filled in as an hour tonight or a weekday and an hour,
  and no silence-filler after it.

### Changed

- The Fish voice waits for the sentence. `JARVIS_FISH_LATENCY` defaults to `normal`, which
  synthesises a sentence whole and gets the stress and the melody right more often, at three
  seconds to the first word against one for `balanced`, which remains a setting away. The buffer
  inside a sentence goes from the minimum of a hundred characters back to Fish's own two hundred,
  since the voice flushes at every sentence end anyway and a sentence cut in half is where the
  melody went wrong. `JARVIS_FISH_NORMALIZE` (on) has Fish write numbers and times out before
  reading them.

## [0.25.0] - 2026-09-16

### Added

- No dashes in speech. The model writes the dash that joins two clauses the way it read it
  everywhere, and out loud that is nothing, on the transcript it is the one mark that says a
  machine wrote this, and asking the persona not to helped some of the time. `SpokenText` takes
  them out of every answer on the way to the voice and the screen: an em dash anywhere, an en dash
  or a hyphen between spaces, split across chunks or not. After a full stop, a colon or a comma the
  dash is dropped, since the pause is already there; elsewhere it becomes a comma, which is what a
  person would have said. Hyphens inside words and en dashes inside ranges stay.

### Changed

- The line that fills a silence is never the one said last. Two turns in a row that opened with
  the same words sounded like a recording, and with three lines to choose from that happened one
  time in three.

### Fixed

- The HUD kept showing what the brain was fetching after it had said "Momentje." That line arrives
  as text, and the first text of a turn was the point at which the panel switched to "responding"
  and stopped naming tool calls, so a briefing that opened with one ran its whole half minute of
  fetching behind a label that said the answer was being given. The brain now marks an opening as
  such on the wire, and the panel waits for the first word of the answer proper before it stops
  saying what the turn is doing.

## [0.24.1] - 2026-09-16

### Fixed

- The Fish voice speaks within the HUD's patience. Fish gathers text until it has three hundred
  characters before it synthesises anything, and the answer reaches it a few words at a time, so
  the first audio of a real turn arrived long after the nine seconds the HUD allows before reading
  the answer itself -- every turn fell back to the browser's voice, with nothing in the log to say
  so. The one test that passed had sent a whole paragraph and its `stop` in a single breath. The
  voice now flushes Fish at the end of every sentence and asks for the smallest buffer it allows
  inside one.

## [0.24.0] - 2026-09-16

### Added

- A second voice. Fish Audio speaks over the same shape of socket as ElevenLabs -- text in as it
  is written, audio back while the rest is still being thought -- and its `s2.1-pro-free` model
  does so at no cost and with no character cap, where the free ElevenLabs tier is spent after ten
  minutes of speech a month. `FISH_AUDIO_API_KEY` turns it on; `JARVIS_VOICE_PROVIDER` says who
  speaks when both keys are given, and ElevenLabs keeps speaking unless told otherwise.
  `brain/src/voice/index.ts` is the only file that knows there are two: the conversation asks it
  for a voice and gets one. What Fish does not send is per-character timing, so the HUD paces the
  transcript by the audio's length on that voice, which it already knew how to do. Listening stays
  with ElevenLabs Scribe: Fish transcribes files, not a live microphone, and the text that appears
  while you are still speaking is not something to give up for a cheaper bill.

## [0.23.1] - 2026-09-15

### Fixed

- The line that fills a silence is no longer swallowed by a greeting. It was armed at the first
  tool call and cancelled by the first word of any kind, and both ends of that were wrong. A cold
  session spends seconds starting before it has read the question, and reaches for nothing in that
  time. And "Goedemorgen." arrived at 1.6 seconds, was read as an assistant that had started
  answering, and was followed by twenty-two seconds of nothing: twelve characters are not an
  answer. The clock now runs from the question, is restarted by every word said before the answer
  proper, and stops for good at the first word said about what a tool came back with -- which is
  the point the answer has genuinely begun. Where that boundary is lives in `Opening`, apart from
  the conversation that owns the clock, because it was got wrong twice by reasoning about it and
  the third version is one that can be tested by calling it.

## [0.23.0] - 2026-09-15

### Added

- A turn that goes quiet to fetch says so. Half a minute of silence between a question and its
  answer is indistinguishable, from across a room, from not having been heard -- and the morning
  briefing is seven tool calls long. The assistant is asked in its own prompt to speak before it
  reaches for anything, and does, some of the time: first word at 1.6 seconds on one turn and
  10.3 on the next, on the same question in the same words, and not at all when the same thing is
  asked in other words. An acknowledgement that only sometimes arrives is worse than none, so this
  one is not left to the model. `JARVIS_THINKING_LINES` holds the sentences, one is picked at
  random, and `JARVIS_THINKING_AFTER_MS` is how long a turn may work in silence first. The clock
  starts at the first tool call rather than at the question -- a turn that reaches for nothing is
  already answering -- and the first word of the answer cancels it, so only one of the two ever
  speaks and an ordinary question hears none of it.

## [0.22.1] - 2026-09-15

### Fixed

- The voice survives an answer that pauses to fetch. The stall timer was armed by a chunk of
  audio and by nothing else, so eight seconds without one was read as a dead stream: the player
  was torn down, the turn's voice went with it, and whatever the answer said after that appeared
  on screen in silence. That is the exact shape of a briefing which greets first and then spends
  half a minute on its tools -- the pause is the work, not a fault. Text and tool calls now
  re-arm the timer, and only a timer that is already running, so nothing here can start the
  clock before the first chunk of audio has been heard. Twenty seconds rather than eight, which
  is what it takes to outlast the slowest single tool once the gaps in between are legitimate.

## [0.22.0] - 2026-09-15

### Added

- A window can ask for a list that does not light up: `quiet` on a panel payload. The gold that
  travels with the sentence picks one row out of a list of separate facts, which is worth having
  when a night's readings are read out one by one. It is worth nothing when the whole list is the
  thing being talked about -- a window of four chosen mails, say -- because then every row lights
  in turn and the light stops meaning anything. A quiet panel also keeps no rows for the reveal to
  wait on: none of its rows can be the row he has reached.

## [0.21.0] - 2026-09-14

### Added

- The publication check reads the target of every tracked symlink. `git grep` walks blobs as
  text and a symlink is not text to it, so the rules looked straight past one -- and a symlink is
  the shortest way to write somebody's home directory into a repository. A link named `packs`,
  pointing at one machine's checkout, had been committed twice and was on `main`: it named the
  account and the layout, and it would have broken the install of anyone who cloned it. An
  absolute target now fails on sight, whatever it says; a relative one is scanned like any other
  line. The link itself is untracked again, and `.gitignore` lost the trailing slash that let it
  through -- `packs/` does not match a symlink named `packs`, which is the same trap `config`
  already had a comment about.
- The publication check reads commit messages. A message is published with the history and
  cannot be corrected afterwards without rewriting every sha below it, so the only place to catch
  one is where it is written. By default it scans the commits being added -- against the branch's
  upstream, or `--since <rev>`, and `--since ""` for everything reachable -- because the history
  is dealt with once, by the commit publication is made from, and every message after that is
  this check's job.

### Fixed

- The private-address rule no longer reads a version number as an address. The three ranges
  shared one pair of trailing octets, which is right for `192.168` and `172.16` and one octet
  short for `10`: `10.5.0` matched. That false positive is why `package-lock.json` was excluded
  from every structural rule -- so a resolved `file:` path naming a machine, or anything else in
  the largest generated file in the repository, was never looked at either. The rule counts its
  own octets now and the lockfile is scanned like everything else.
- A no-reply address is no longer reported as a mailbox. It is a service saying it has no
  mailbox, on the same ground `git@` is already excluded, and every commit here carries one in a
  trailer -- a rule that fires on every commit is a rule nobody reads.
- The publication gate no longer fails a pull request from a fork. The job tested
  `github.repository`, which on a pull request is the repository the branch is aimed at rather
  than the one it came from, so it started on every outside contribution and then failed on the
  secret that is withheld from forks by design. It tests the head repository now, and a fork's
  first run is the acceptance suite alone.

## [0.20.1] - 2026-09-14

### Fixed

- The name of a window is back on it. A card became a fixed height in 0.20.0, so a list longer
  than the card overflows it, and a flex item gives way by default: the heading was squeezed from
  16 pixels to 7 and then out of sight altogether. Worst on the mail window, which is the longest
  list, and on every window once it was a thumbnail -- exactly where the name is the only thing
  left to recognise it by. The heading no longer shrinks; the body is the part that takes what is
  left.

## [0.20.0] - 2026-09-14

### Changed

- One thing blinks at a time. Everything that lights up gold counts five breaths, but items can
  follow each other faster than that -- three agenda entries inside one sentence -- and three rows
  breathing together say "look here" three times over. A row that lights up now takes the gold off
  whoever had it: the one before it stops mid-count and leaves in a blink instead of over the full
  fade, so what is blinking is always what is being said.
- A window is a frame rather than a bag. It is the same height whether it holds a three-line
  forecast or twelve mails, and a list longer than the frame scrolls inside it. Growing with its
  contents put the mail window straight through the state line at the bottom of the screen, and
  moved the thumbnail row every time the subject changed -- the two things you find your way by,
  never twice in the same place. The height is measured rather than guessed: the windows are
  centred, so the state line costs its own height twice over, and that height moves with the
  breakpoint. The thumbnail row holds its place while it is still empty, and gives it up only on a
  screen too short to afford it.

## [0.19.0] - 2026-09-14

### Changed

- The context panel carries no highlight at all any more. It is a standing sheet of figures --
  the weather, the mail, the agenda, sitting under each other until a newer reading of the same
  subject replaces them -- and gold on it meant "this landed a minute ago", which is not something
  a sheet of figures is read for. What is worth pointing at is pointed at in the window, where it
  is a row of a list and the sentence is about it. The gold machinery on the panel is gone rather
  than switched off: no arrival glow, no standing mark, no repaint ticker.

### Added

- A window row can arrive marked. `mark` on a panel row is a standing mark rather than the gold
  that says a row is being spoken about: out of a list of mails, these are the ones that want
  something from you. It does not breathe and it does not go out, and the row being spoken about
  still outshines it while it is lit.
- A pack can replace something it put on screen. `display()` takes back an id it was given
  earlier, and the HUD clears the card with that id before drawing the new one -- so a window that
  gains something a moment after it went up is the same window, not a second copy of it.

### Fixed

- Folding the windows away with every one of them minimized leaves the corner filled. The fold
  docks "the one being read", and with the stage empty that was nothing at all: the orb took the
  middle and the corner it left behind was blank, so there was nothing to point at and nothing to
  click back. The newest thumbnail stands in -- it is the one that would come back first anyway --
  and it remembers where it came from, so unfolding returns it to the thumbnail row instead of
  promoting it to the stage.

## [0.18.0] - 2026-09-14

### Changed

- Everything that lights up gold now counts the same five breaths and then goes out: a context
  tile that just arrived, the row of a window he is talking about, and today's row of a dated
  table. Two of those had their own timing before -- a tile settled into a standing mark for
  fifteen seconds, and today's row stayed lit for the rest of the conversation -- so three kinds
  of gold on one screen meant three different things by it. The count and the length of a breath
  are stated once (`CTX_BLINKS`, `CTX_BREATH_MS`) and the fade starts where the fifth breath ends.
- A row is lit once per window. It is marked as having had its turn rather than being recognised
  by the glow it is wearing, so a subject he comes back to later in the same answer does not start
  blinking again now that the glow goes out.

## [0.17.2] - 2026-09-14

### Fixed

- The waveform strip in the footer no longer pushes the text field and the mic
  button off the right edge of the window when the page is zoomed in. The strip
  is a canvas, and its width attribute -- set to the strip's width times the
  device pixel ratio -- acted as an automatic minimum width for the flex item,
  so the footer could not shrink with the window. `min-width:0` releases it.

## [0.17.1] - 2026-09-14

### Fixed

- The text field stays on screen between 720 and 1100 pixels wide, which is where a zoomed-in
  desktop window lands. The header and the footer span three columns, which is right on the
  desktop and wrong against the single-column grid this width uses: the two columns they reached
  for were created for them, and the stage -- which asks for no column at all -- was put in one of
  them, a strip of nothing beside the panels. The footer took the row the stage should have had,
  so the text field floated in the middle of the window and the orb was nowhere. All three are
  pinned to the one column there now.
- The status pills no longer lose their left end. A flex row that overflows and is justified to
  its end is cut off at the beginning, and scrolling does not bring it back; the row is aligned
  with an auto margin instead, which gives way when there is not enough room.
- On a stage too short to centre an orb and still leave the status line its strip, the orb sits at
  the top of the stage instead -- centred, every pixel the text needs costs the orb two. Shorter
  than 150px the orb goes altogether rather than being a bead with the words printed across it.
- The side panels take at most a third of the height when they are a row of their own, so the
  stage is not left with the remainder.

## [0.17.0] - 2026-09-14

### Changed

- The health probe says "All servers online" when they all answered, instead of reading out the
  whole roll call by name. The roll call was the same line every time and it cost the log one of
  the eight it has, which pushed the greeting off the top to say nothing. What is wrong is still
  named, one line each: a cross and the reason for a server that did not answer, a dot for one
  that was never configured, and "All other servers online" after them when there were any.
- The status line sits level with the bottom corners of the frame rather than at a percentage of
  the stage, so it reads as part of the frame and keeps its distance from the orb at any height.
- Memory and the tour swap places in the header row, and their order is now set in the stylesheet
  rather than being whichever of the two modules happened to run first.

### Fixed

- The text field comes back when the page is zoomed in. The status pills wrapped, so past a
  certain zoom the header grew a row at a time; its height comes off a grid that is exactly the
  window tall, and a third row of pills pushed the footer -- the text field with it -- off the
  bottom. The row is one line that scrolls sideways now, the stage is the track that gives way
  instead of the footer, and a short window puts the header and footer into a smaller form: the
  subtitle and the shortcut hint go, the wordmark and the clock shrink.

## [0.16.1] - 2026-09-14

### Fixed

- The orb stays out of the status line when the page is zoomed in. It was sized against the
  window, but it stands on the middle band between the header and the footer, and that band
  loses height far faster than the window does: the header and the footer are written in
  pixels and keep their size, so zooming in takes the difference out of the middle. Past a
  certain zoom the orb was taller than the room it had and "standby" was printed across its
  outer rings. It is now measured against that band, with the bottom strip the state text
  sits in kept clear.

## [0.16.0] - 2026-09-14

### Added

- A pack may offer readings to take on a clock (`watch` on its setup), and core takes them once a
  minute for as long as a HUD is open. The house offers one: the agenda. What is next stops being
  next the moment it starts, and until now the panel only found that out if somebody asked again.
  The readings travel the path a tool's own figures take, so an unchanged agenda changes nothing on
  screen and a new "next up" lands as news, gold and all, without a question.
- Today's row in a dated list is lit from the moment the list goes up. The nightly pass over the
  notes puts one row on screen per night; one of those rows is about now, and it is the row the eye
  wants first. The date is read off the label in whatever shape it was written -- `2026-09-14`,
  `14-09`, `14 sep`, `vandaag`.
- A minute with no touch, no key and nothing being said folds the windows away and gives the orb
  the middle of the screen back, exactly as clicking it does. What was being read waits in the
  corner as a thumbnail, one click brings it back, and the minute starts again. Anything at all
  restarts it, so nothing is ever folded away while it is in use.

### Changed

- The gold on a context block is timed from the moment the block lands rather than from the moment
  its tool answered. A block is held back until its subject is spoken, which in a briefing is a
  minute after the figures arrived -- long enough that the fifteen seconds were over before the
  tiles were on screen, so the arrival was never seen at all.
- Only the readings that are the news light up. The weather answers with five figures and one of
  them is today; the rest are what today is being compared against, and lighting all five made a
  block shout where it meant to point.

### Removed

- The standing blue on a context tile. `on` is a pack calling one figure the notable one, and next
  to the gold it read as a second highlight that never went out: the mail and the agenda sat lit
  long after they had stopped being new.

## [0.15.0] - 2026-09-14

### Added

- The context panel is a standing sheet rather than a single slot. One block per subject -- the
  weather, the mail, the agenda, the house -- each replaced only by a newer reading of itself,
  newest on top. Asking about the weather used to throw away what the mail had said a minute
  earlier, because the panel was keyed on the server that answered and the house answers about all
  three.
- The sheet is trimmed to its column rather than scrolled. Nothing on the panel scrolls in either
  direction: blocks come off the bottom as new ones arrive at the top, which is the same order the
  conversation leaves them in.
- Blocks arrive on the word. A block is held back until JARVIS actually reaches its subject and put
  up when the answer ends if he never does -- the timing a window already had, now shared by the
  panel, so the figures land under the sentence they belong to instead of two sentences early.
- Gold marks what is new. Each reading that just landed glows gold and breathes three times, stays
  marked for fifteen seconds, and then goes out over two and a half rather than between two blinks.
  It is the readings that light, not a ring around the block: the heading already says which
  subject came up.
- The same gold marks the row being spoken about, on the same clock. Out of a list of twelve mails,
  the one the sentence is about lights as he reaches it -- matched on the words of the row against
  the words already spoken, so it needs nothing from the pack that drew the window.
- The panel survives the page. What is on the sheet is written to the browser, so closing the HUD
  and opening it again picks the conversation up where it was rather than at nothing.
- A weather block of its own. The forecast used to file its figures under the house, which meant
  any other question about the house replaced them.

### Changed

- JARVIS no longer says what is on the screen. Every display tool answered "Panel is on screen.",
  which reads as news worth passing on, and the answers duly ended in "de historie staat op het
  scherm" -- a sentence that tells someone looking at the screen what they can already see. The
  tools now answer with the instruction instead of the fact.
- A window's table wraps instead of widening. A long subject line used to push the window sideways
  and leave it scrollable; the columns are now fixed and the text wraps inside them.
- The panel is furniture: it is on screen before the first question, with a line saying what will
  land there, instead of appearing and disappearing. It also takes the height it needs from the
  system readings below it, which never needed half a column for five rows.
- The server name next to the heading is gone. Every block says which subject it is, which is what
  the name was standing in for.

## [0.14.0] - 2026-09-14

### Added

- The windows have a size of their own. A small control above them grows the card, its text and
  its width together, remembered per browser. Browser zoom was the only answer before, and it
  enlarges the header, the panels and the transcript along with the thing you wanted bigger.
- The orb and the windows now take turns instead of sharing the screen. Clicking the orb folds the
  windows away and gives it the middle back at full size; the window that was being read stays as a
  thumbnail in the corner the orb just left, and clicking that brings the windows back. Something
  new to show unfolds them on its own.
- `recent_screens` and `show_again`: the brain keeps the contents of everything it put on screen,
  and the HUD reports which window left and why. A window closed by accident can be asked for again
  in words -- answered from what was already shown rather than by fetching the same thing a second
  time, which is slower and can come back different from what was on screen.

### Fixed

- Closing the window being read used to leave an empty stage under a row of thumbnails. The most
  recent thumbnail now takes its place.

## [0.13.2] - 2026-09-14

### Fixed

- A tool call that runs out of time gets the same refusal as a server already known to be dead.
  It used to be told only that the server "did not answer in time", which reads as news worth
  passing on, and the briefing duly passed it on. The first turn after a restart is precisely when
  no verdict exists yet, so that was the turn that reported the outage -- the one case the silence
  was meant for.

## [0.13.1] - 2026-09-14

### Fixed

- A tool call to a server the probes just found dead is refused at the transport instead of being
  forwarded. Waiting for a dependency to time out again proves nothing that was not measured a
  minute ago, and it was being paid once per tool per turn: with three servers down, a morning
  greeting spent twenty seconds on them before it reached the weather. The refusal asks for that
  part to be left out without being mentioned -- a machine this deployment cannot reach is not news,
  and saying so every morning turns a briefing into a list of other people's outages. Nothing has to
  be switched off for this to work: the probes now run on a clock rather than only when a browser
  connects, a tool that answers is recorded as up whatever the last probe thought of it, and a
  server whose verdict has gone stale is tried again.
- A voice balance too small for a sentence is now treated as no balance. The test was for zero, so a
  balance of ten characters passed it: the socket opened, the brain announced a voice, and the
  refusal arrived only once the first sentence was sent -- with the HUD holding the answer back all
  the while, waiting for audio that was never coming.

## [0.13.0] - 2026-09-14

### Added

- A layout for the HUD on a phone. The screen was built for a desk: three columns, a space bar to
  talk with, and a transcript living in the left-hand one. On a phone that grid did not collapse so
  much as spill -- the status pills are a single unbroken row, and a `1fr` track is floored at the
  width of the widest thing inside it, so the page grew past the screen and the controls ended up
  beyond the right edge. Below 720px wide, and on any short screen with a coarse pointer, the grid
  is one column, the transcript becomes a sheet you drag up from the bottom by its grip, and the
  footer carries a round button you hold to talk and release to send -- which is what the space bar
  already does, and a phone has no space bar. The tour and the memory panel follow the same
  breakpoint: the tour pulls the sheet open before it rings anything parked inside it, and the
  memory overlay takes the whole screen rather than floating in a margin that is not there.

### Changed

- Nothing above 720px. Every rule added here sits inside the phone breakpoint and the two new
  elements are `display:none` until it applies. Checked by measuring the rendered layout at
  1920x1080 and at 1280x800 before and after: identical.

## [0.12.2] - 2026-09-13

### Added

- A picture of the screen at the top of the README. Everything the HUD is was described in prose and
  nowhere shown, which asked anyone deciding whether to run this to imagine it. The shot is a real
  turn on a real deployment with the roll-call of that deployment's packs and two momentary tool
  timeouts hidden, since neither is the product and the pack names are somebody's.

## [0.12.1] - 2026-09-13

### Changed

- The example pack puts something on screen. It filled the context panel and stopped there, so a
  pack written by copying it got the tiles for free and never learned that a window of its own
  existed: `create()` threw its context away, and neither the file nor its README said the word
  `display`. It now takes `context.display`, hands it to the tool, and shows the greeting anchored
  on the word the answer is about to say -- a word taken from the answer rather than guessed at,
  which is what the anchor rule asks for and what the new test holds it to.

## [0.12.0] - 2026-09-13

### Added

- The screen keeps up with the voice. Everything put on the display now carries a cue saying where
  in the answer it belongs -- how far the answer had been written when the tool was reached for --
  and the HUD holds it there until the spoken answer arrives at that point. A tool answers in
  milliseconds and the sentence about it comes seconds later, so until now a briefing put its last
  subject on screen while still talking about its first.
- An anchor word, optional, on every display tool and on `context.display()` for packs: a word the
  answer is about to contain -- "mail", "agenda" -- which the window waits for instead of the
  character count. A word that is never said is not lost; the window goes up when the answer ends.
- More than one window at a time. What is being talked about is read at full size, and what came
  before it shrinks into a row beneath it -- the same animation, reversed -- four in view at most,
  the oldest dropping out. Clicking one brings it back up and sends the current one down. A briefing
  about the house, the mail and the agenda now ends with all three side by side rather than with
  only the last one.

## [0.11.0] - 2026-09-13

### Added

- The assistant knows how it is built. The system prompt now carries a record generated from the
  running process: which packs are installed and which of those are running, off, broken or not
  packs at all; which of the variables an off one declared are empty, and what each is for; whether
  core has the house credentials, a voice, a written channel, an observation layer, a repository to
  change itself in; and every tool server registered this session. It ends in the rule the whole
  thing exists for -- if a capability is not in that record, this deployment does not have it -- and
  in an instruction not to name a pack or a repository that does not appear in it.
- `my_setup`, a core tool that returns the same record with every dependency asked, at that moment,
  whether it answers. Configured and reachable are two different answers, and the prompt can only
  ever carry the first.
- `summary` and `needs` on the pack contract, both optional. A pack declares the variables it reads
  and half a sentence saying what each is for; core reads the environment itself and reports which
  are empty. `configured()` remains the authority on whether the pack runs, so the two may disagree
  in the direction of "everything is set and it still says no", which is reported as exactly that
  rather than smoothed over. [examples/pack](examples/pack) declares both.

### Changed

- `Packs.skipped` is now `Packs.reports`: one entry per directory under `packs/`, with what became
  of it, instead of a list of the failures only. `notRunning()` is the old list. Internal to core.
- A directory under `packs/` with no `pack.json` is reported as `unrecognised` rather than passed
  over in silence. It stays out of the log -- there are innocent ways to end up with one -- but it
  is the case that makes a missing capability confusing: build output a removed pack left behind
  occupies the name and answers nothing, and from the outside it looks installed.
- A pack whose second server hits a name another pack already took is reported as started with a
  problem, rather than as skipped. It was neither before.
- `prompt-size-cli` counts the deployment block, which is now part of what every request pays for.

### Fixed

- Asked how to connect Home Assistant, a deployment with no house credentials and no packs answered
  that the connection was already there, while the pill on screen read *not configured*. Nothing was
  broken: the persona describes an assistant with a house, and no part of the prompt described the
  machine it was actually running on. It now does, first, before any pack gets to speak.
- The version the HUD showed came from `brain/package.json`, which no release bumps, so it read
  0.1.0 through ten of them. It now comes from the repository's own manifest -- the number the
  changelog and the tags use -- which is the drift that file was written to prevent.

## [0.10.0] - 2026-09-13

### Added

- One envelope for every tool of every pack: `answer(say, facts)` returns the sentence the
  assistant phrases its reply from and the same reading already labelled. The figures ride back on
  the answer itself, so the context panel costs no call, no cache and no second fetch, and it can
  never disagree with what was said out loud. Nothing is parsed out of prose and nothing is asked
  of the model -- a figure it was told to repeat is a figure it can get wrong.
- `docs/packs.md`, the pack contract as prose: the shape of the directory, the two rules that hold
  in no type, what belongs in `configured()` as against `create()`, when a server owes a probe,
  what a tool returns, and a checklist to build against. The contract was already written down in a
  type, a loader and an example — all accurate, none of them a place to start — so every pack
  rediscovered the same habits and skipped a different one of them.
- The context panel is stated as an obligation rather than a capability. It shipped in 0.8.0 and no
  pack ever filled it, which is what an optional-sounding feature gets: the panel built to stop the
  screen inventing figures showed nothing at all instead.

### Changed

- **Breaking for packs that filled the context panel.** `PackSetup.tiles` is gone, with the
  callback per server, the two-second timeout and the caching a pack needed to answer within it. A
  pack now puts its facts on the answer it was already returning. No pack in the wild used it.
- A tool that fails carries no facts, so a failure leaves the panel as it was rather than blanking
  it. Nothing new was learned; the screen should not claim otherwise.

### Fixed

- The committed `package-lock.json` said 0.4.0, so every `npm install` rewrote it and every pack
  test run started with a dirty tree it had not caused.

## [0.9.0] - 2026-09-13

### Added

- An onboarding tour in the HUD. On a first visit JARVIS asks whether to show you around and takes
  no for an answer permanently; a button in the header runs it again. Seven steps ring one panel at
  a time and say what it is: how to talk to him, the transcript, what the pipeline's milliseconds
  are, where the context tiles come from, what each system meter measures and why one may read as
  an em dash, what the pills and their marks mean, and what this install can actually reach. Until
  now the screen explained itself to nobody: every panel on it was written for someone who already
  knew what it was.
- The tour is a script in the page rather than a conversation. No model is asked anything, so it
  behaves the same with no packs, no house, no microphone and no API key -- which is precisely the
  machine most likely to need it. Speech goes through the same `say` path the arrival greeting
  uses; when nothing can speak, the cards say it all anyway.
- `pack` on a health row, saying whether a pack contributed it. The tour's last step answers "what
  can you do here" out of the probe results, and core's own two rows are not an answer to it: an
  install that reaches nothing still has a display and a memory.

### Changed

- What the tour cannot show, it does not describe. A deployment with no tiles is told why there is
  no context panel; a screen too narrow for the right-hand column is not told about it at all, and
  the tour renumbers itself to the steps it can honestly make.

## [0.8.0] - 2026-09-13

### Added

- `tiles` on the pack contract: what the HUD's context panel shows while that pack is the one
  doing the work, keyed by server name the way `probes` already was. Core reads the server out of
  the tool names it is already streaming to the pipeline panel, so the panel follows the
  conversation without a tool call being spent on it and without the model deciding anything. A
  pack is given about two seconds and is expected to compute rather than fetch; one that throws,
  times out or has nothing to report leaves whatever is on screen alone.
- The example pack demonstrates it, and its README carries what the type cannot say.

### Changed

- The context panel shows what a pack put there instead of eight invented readings — a living room
  temperature and a washing machine, hard-coded since the first HUD, on machines that had never
  been told about either. The set that arrives stays up until another pack replaces it, because
  "what are we talking about" does not stop being true between two questions.

### Removed

- The placeholder tiles, and with them the last invented figure on the screen. A deployment whose
  packs offer no tiles now gets no panel rather than an empty one.

## [0.7.0] - 2026-09-13

### Added

- `examples/pack`, the smallest pack the loader will start: one setting, one tool, one paragraph of
  prompt, and no dependency outside the process. The contract was documented in three places and
  demonstrated in none, because every pack written against it is somebody's house and stayed
  private, which left the shortest path to a working pack running through 300 lines of loader. It
  is copied into `packs/<id>` rather than loaded from where it sits, and it is built and tested
  with the rest of the repository so that it cannot quietly stop being true.
- The README beside it carries the two rules that hold in no type and still bite: read
  `process.env` and never core's `Config`, and depend only on what `brain` already depends on,
  since `packs/` is deliberately not a workspace.

## [0.6.6] - 2026-09-13

### Changed

- The certificate section says what an authority of your own costs. `mkcert` was listed as an
  equal third option and it is not quite one: its root is trusted on the machine that installed
  it and nowhere else, so every other phone, tablet and laptop that opens the HUD has to be told
  about it separately. The way that failure presents is why it earns a sentence -- the page
  loads and the assistant answers, and the only thing missing is the microphone.

## [0.6.5] - 2026-09-11

### Changed

- The shipped manifest lists no packs. It named three repositories that are not public, so the
  install step that reads it failed on all three for anybody but their owner, and the README
  described them as published alongside core. Nothing is published alongside core: a pack is
  somebody's house and somebody's credentials. What the README carries instead is the shape --
  the manifest entry, `configured()` and `create()`, and a pointer at the loader, which is the
  whole of the contract.

## [0.6.4] - 2026-09-11

### Documentation

- The README says that there is no login, where somebody installing this will read it. Whoever can
  open a websocket to the port can drive the house, the server listens on every interface the
  machine has, and the spoken confirmation before an irreversible act proves intent and not
  identity. It was written down once, in the known-gaps list at the end of the operations guide,
  which is not where that belongs. That entry no longer suggests a bind address, because there
  is none.

## [0.6.3] - 2026-09-11

### Documentation

- The install steps run as written. `config/` is ignored here, so a fresh clone does not have it and
  the first thing the block asked for -- copying the persona into it -- failed on the directory. The
  persona and the seeds are now put in place before `npm run packs-sync`, which is also the order
  that command wants: it reads `config/packs.json` on top of the manifest that ships here.

- What `packs-sync` ending non-zero means is written down. A pack whose repository cannot be reached
  is a failed line, not a failed install; core is what runs with no pack at all, and a pack can be
  added to a machine that has been running for months.

## [0.6.2] - 2026-09-11

### Fixed

- Self-development asks whether `origin` will take a branch before it writes one. On a copy of this
  repository that is somebody else's install, `origin` is the repository it was cloned from and
  nothing there will accept its branch. The refusal used to arrive at the end -- after a worker had
  spent up to a quarter of an hour on a change and the suite had run green on it -- and the commit
  was thrown away with the worktree. It is now a `git push --dry-run` at the top of the pipeline,
  and what comes back says what to do about it.

### Documentation

- README says what self-development needs on an installation that is not the one it was cloned from:
  `origin` repointed at a copy of your own, that same repository in `JARVIS_GITHUB_REPO`, and a
  token in `GITHUB_TOKEN_JARVIS`.

## [0.6.1] - 2026-09-11

### Fixed

- The checks JARVIS makes on himself now run on a deployment with no house. They were armed inside
  the branch that needs a house to watch, so `HA_URL` left empty took the backups, the notes, the
  memory counts, the failed units and the deploy state down with the observation layer -- a
  documented "deliberately run outside the house pass" that the code did not do. The hourly pass is
  now armed either way; only the house half of it depends on there being a house.

- How long an installation has been running no longer comes from the observations alone. It was read
  from the oldest observation bucket, which a houseless deployment never writes, leaving every job
  permanently too young to be called late -- the "has never reported" check could not fire at all.
  It is now the older of that and the oldest self metric, which is written hourly regardless and
  kept for longer than the most generous tolerance any job has.

- The nightly baseline rebuild is expected only where there is a house. It is the one job armed
  in-process rather than by a timer, so there was no enabled-or-not to read an intention off, and a
  houseless deployment would have been told daily that a rebuild it was never going to attempt had
  never run.

## [0.6.0] - 2026-09-11

### Removed

- The `home-assistant` pack, the last one this repository carried. It lives in
  [`jarvis-pack-hass`](https://github.com/jrhimself/jarvis-pack-hass) now and is installed like any
  other, at `packs/hass`. The three MCP servers keep the names they had -- `ha`, `control` and
  `calendar` -- so no tool is renamed and nothing that refers to one has to change.

- `JARVIS_CALENDARS` from core's configuration, with the `envIds` reader that existed for it. The
  pack reads the variable itself; the name and its value are unchanged, so no env file needs
  editing. `HA_URL` and `HA_TOKEN` stay, because the observation layer is core and watches the house
  whether or not anyone is talking to it -- the pack reads those two from the environment as well.

- The list of packs still on their way out of this repository, from the publication check. There are
  none left, so `packs/` is asserted to have no tracked files at all, and a named directory under it
  in either npm manifest is somebody's own pack rather than one of ours.

### Migration

- Install the pack at `packs/hass` before restarting, or the assistant goes on watching the house
  while losing every way to act on it or read an agenda. It is in the shipped manifest, so
  `npm run packs-sync` clones and builds it. Remove `packs/home-assistant` and the `dist/` it leaves
  behind -- a pull does not clean up build output, and two copies of one pack on disk is a question
  about which of them ran.

## [0.5.0] - 2026-09-11

### Removed

- The `mail` pack, which now lives in a repository of its own as
  [`jarvis-pack-gmail`](https://github.com/jrhimself/jarvis-pack-gmail) and is installed like any
  other. It is called `gmail` there, after the provider it actually speaks to: what it reads is one
  mailbox over Google's own API, not mail. The MCP server, its tools and the health row carry that
  name with it.

- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN` from core's configuration, and
  `scripts/gmail-auth.mjs` with them: the pack reads those variables from the environment itself and
  carries the script that mints the token. The variables and their values are unchanged, so no env
  file needs editing; what is lost is core's warning about a client id set without a refresh token.

### Migration

- Install the pack at `packs/gmail` before restarting, or the briefing loses its mail: it is in the
  shipped manifest, so `npm run packs-sync` clones and builds it. Remove `packs/mail` and the `dist/`
  it leaves behind -- a pull does not clean up build output, and two copies of one pack on disk is a
  question about which of them ran.

## [0.4.0] - 2026-09-10

### Changed

- No pack is part of core any more. Every pack -- the ones this project publishes as much as the
  ones a household wrote for itself -- is a checkout of a repository of its own under `packs/`,
  cloned there by `npm run packs-sync`. `packs/local/` is gone with the distinction it stood for,
  and so is the rule that a local pack shadows a first-party one of the same name: two packs
  claiming the same name were two entries claiming the same directory, which the manifest now
  settles before anything is cloned. What this buys is that core can be read, forked and run by
  somebody whose house has none of the things these packs talk to, and that a pack can be handed
  over without the rest coming along.

- `packs-sync` reads two manifests and merges them: `examples/packs.json`, shipped here, and
  `config/packs.json`, the deployment's own. An `id` present in both replaces the shipped entry
  rather than adding a second, so a deployment can pin a published pack to a fork or a branch
  without restating the others -- and, more to the point, a deployment that lists packs of its own
  keeps receiving the ones it did not list. Which manifest each pack came from is printed.

- The self-development guard protects `packs/` wholesale. It named the house's confirmation guard
  file directly before; now the reason is the general one -- no pack is in this repository, so a
  fix that reached into one would be editing a file the pull request cannot show.

- `scripts/build-local.mjs` is `scripts/build-packs.mjs`, and the publication check asserts that
  `packs/` as a whole is untracked. The two first-party packs still on their way out are named in
  one list in that script, which deletes itself when the last of them leaves.

### Removed

- The `weather` pack, which now lives in a repository of its own and is installed like any other.
  With it went `ACCUWEATHER_API_KEY` and `ACCUWEATHER_LOCATION` from core's configuration: the
  pack reads them from the environment itself, which is what makes it installable somewhere that
  never heard of this `Config`. The variables and their values are unchanged, so no env file needs
  editing; what is lost is core's warning about one half of the pair being set without the other.

### Fixed

- `packs-sync` no longer hands a directory that is not a TypeScript project to `tsc`. Build output
  left behind by a pack that has moved away looks like a pack from the outside, and a sync that
  ended in `error TS5083: Cannot read file .../tsconfig.json` said nothing about what was actually
  wrong. The directory is reported and skipped, as it already was for the fetch.

### Migration

- A deployment upgrading past this moves each of its pack checkouts from `packs/local/<id>` to
  `packs/<id>`, and each pack's own `tsconfig.json` reference to `shared` from `../../../shared`
  to `../../shared`. Do both in one window: the loader scans `packs/` and nothing deeper, so a
  checkout left behind is an assistant that starts without its tools and says so.

## [0.3.0] - 2026-09-08

### Added

- `scripts/check-no-house-facts.sh --path <checkout>` scans a repository other than this one with
  this deployment's denylist. A pack is a checkout of its own, which this repository refuses to read
  beyond asserting it is untracked -- correct, since it belongs to somebody else, but it left the
  guard stopping precisely where the repositories most likely to be published begin: a pack has no
  denylist of its own and usually no CI, so nothing looked inside one at all. A real chat identifier
  had reached a pack's README as its example value and sat there from the first commit, invisible to
  every check there was. Only the mechanism travels -- the words are read from beside the script and
  never from the tree being scanned -- and neither the argument nor the path it points at is ever
  printed. Running it before a pack is pushed or made public is written down in
  [AGENTS.md](AGENTS.md).

### Fixed

- The mailbox rule no longer reads an ssh clone url or an RFC 2606 example address as somebody's
  address. `git@` names a forge rather than a person and stands in the install instructions of
  every pack, and a reserved name only counts as the last label, so the domain `invalid` excluded
  `runner.invalid` in name only. Both went unnoticed while the check saw nothing but this
  repository; aimed at four pack checkouts it produced these and nothing else, and a guard whose
  every hit is wrong is a guard that stops being run.

## [0.2.0] - 2026-09-07

### Added

- `npm run packs-sync` installs the packs a deployment runs. A pack that is not first-party lives
  in its own repository so that it can be given away on its own, and the price of that was a
  reinstall becoming an exercise in remembering which repositories there had been.
  `config/packs.json` is now the single place a pack is named: the script clones what is missing,
  fast-forwards what is not, and builds the result. It reports and skips a checkout with
  uncommitted work, or one on a different branch than the manifest asks for, rather than resetting
  it -- unfinished work is far likelier there than debris.

- JARVIS watches over the jobs he hands to a runner elsewhere. Delegation used to be one-way:
  the job left and the slot it went into stayed open until somebody noticed, which on a machine
  that stays up for weeks means the next job has nowhere to go. The far side now reports the
  last screen of a quiet pane to `/runner/report`, and the judgement happens here, where the
  brief that was given is: a runner asking a question has it relayed, a runner that is finished
  is offered a button to close its slot, and the slot is closed only once that button is
  pressed. Nothing closes on its own -- a screen that does not clearly say it is finished is
  read as still working, because the cost of misreading an ending is work thrown away.
  Configured with `JARVIS_RUNNER_TOKEN`; without it the endpoint does not exist.

- A stronger model for the turns that need one. A conversation runs on `JARVIS_MODEL` and is
  raised to `JARVIS_ESCALATE_MODEL` the moment a tool comes back in error or a building tool is
  called, for the rest of that turn and for the turn after it, and then goes back down. The
  trigger is evidence rather than subject: no list of trigger words, which would be a fourth
  place for the deployment's language to leak into the program and would still miss the failure
  it was written for. Off unless a second model is named.
- Brakes on a single question. `JARVIS_MAX_STEPS` (16 by default) and `JARVIS_MAX_TURN_USD`
  stop a turn that has started going in circles; the assistant says `JARVIS_STOPPED_SENTENCE`
  instead of falling silent, and the conversation survives its own limit. `JARVIS_FALLBACK_MODEL`
  covers an overloaded primary.

### Changed

- The local packs are built by scanning `packs/local/` rather than by reading a list of project
  references. The list was a second place to register a pack, and the one that was quietly
  forgotten: a pack missing from it still loaded at runtime, because the loader scans, and was
  simply never type-checked.

- A dead end can be handed on. `propose_dev_task` now also takes an investigation into why
  something is broken, not only a change to make. The assistant has no logs, no shell and no
  way onto another machine, so the cause of a failure it just hit is regularly something it
  cannot see; the honest move is to route the question to a runner that can, rather than to
  guess or to stop. An investigation carries no file list, which the existing guard already
  reads as too big to do here, so no new route was needed -- only the admission that this is
  a kind of work worth registering.

### Fixed

- A deployment's own packs no longer break its next deploy. `packs/local/*` was an npm workspace
  glob, which meant two things it should never have meant: the lockfile in this public repository
  listed the private packs of the household that last ran `npm install`, and `npm ci` -- which
  both deploy paths run whenever the lockfile moves -- refuses to run at all when a directory on
  disk is missing from the lock, so installing a pack armed a failure for the next push. The glob
  is gone and the three private names are out of the lockfile. Nothing had to move to make that
  work: a pack's imports resolve upwards into the root `node_modules`, which is how the packs
  installed by `packs-sync` have been running all along.

- The release check reads the npm manifests too. `package-lock.json` is excluded from the pattern
  rules because a dependency version beginning with a ten reads as a private address -- so the one
  file npm maintains by itself was the one file nothing looked at, and it was that file that named three
  private packs of one household in a public repository. A *named* directory under `packs/local/`
  in either manifest now fails the check. A glob still passes; it names nobody.

- A pack cannot be installed where nothing will ever load it. The manifest's `path` is for a pack
  whose directory is not named after its id, but it was taken literally enough to accept any path
  at all, and the loader scans `packs/` and `packs/local/` only. A checkout anywhere else was
  cloned, fast-forwarded and built on every sync while contributing nothing, and said `current`
  each time. It is now refused by name.

- The documentation counts the private paths correctly. `config/packs.json` joined the list of
  things git does not carry without being added to the two places that enumerate it, so both
  AGENTS.md and the fresh-host checklist said five and named four. A checklist that is one item
  short is worse than none: the item it omits is the one nobody misses until the assistant starts
  with no packs.

- Names from one deployment are out of the examples. A handful of comments and test fixtures still
  referred to a pack that has since been split into its own private repository, which told a
  reader of this repository what one household runs and, worse, described a seam in terms of a
  pack that is not here to be read.

- The nightly notes pull writes where the checkout actually is. Its destination defaulted to a
  path under the home directory rather than one derived from the script's own location, so a
  deployment whose checkout is named anything else aimed the pull at a directory the unit does
  not grant write access to -- and `ProtectSystem=strict` failed the pass before a single note
  had been fetched. The unit runs the script with no argument, so the default was the only
  value that mattered.

## [0.1.0] - 2026-09-02

A finding stops being a row in a table. It is put to somebody, in their own language, and what
they say back is written down beside it -- and the same channel carries a question the other way,
so the assistant is reachable from a train.

### Added

- A channel that can answer back. At `JARVIS_PROACTIVE=suggest`, with a bot token and a chat
  configured, a condition that has held long enough is sent to Telegram with three buttons under
  it -- right, noise, later -- and the press is written to the `suggestions` table next to the
  sentence that produced it. Detection can be tuned against recorded hours, and has been twice;
  recorded hours cannot say whether a true reading was a welcome one. The verdict is the first
  labelled evidence in this repository that the rules are getting better rather than quieter.
  `later` puts the *subject* away for a week rather than the condition, because a sensor that
  flaps closes and reopens its condition every hour. Telegram carries it because a long poll from
  behind a domestic NAT needs no inbound port, no domain and no certificate; `brain/src/telegram.ts`
  knows nothing about findings and could carry anything.

- Findings are delivered in the reader's language. A rule still writes one English sentence --
  that is the record, and it is what goes in the database, the log and the tools -- but it now
  also says which sentence it is and what the values were, and the delivery layer renders that.
  The language is the first half of `JARVIS_LOCALE`, because a deployment that has said its house
  speaks Dutch has already answered this and a second setting could only disagree with the first.
  The four house rules carry keys; the self checks are about the machine rather than the house and
  keep their English. A key this table has never heard of, or a language nothing was written for,
  falls back to the stored prose -- an English sentence rather than a missing one is the only
  acceptable way for a translation to break.

- The chat answers questions as well as asking them. The websocket was the assistant's only door,
  which made it unreachable from a train, an office, or a kitchen where nobody wants to talk out
  loud. A message typed at the bot now runs as an ordinary turn on the same `Conversation` the HUD
  drives, with the same session rules -- one agent per chat, dropped after the idle window or the
  turn cap -- and comes back as one message rather than a stream, because a chat that edits its
  own message forty times is unreadable. The voice is off for these: opening it costs credits the
  moment it connects, and audio nobody can hear is the purest way there is to spend them. Only the
  configured chat is answered at all; a bot token is a URL anybody who has it can write to, and an
  assistant that answers strangers reads a house's memory to strangers. Telegram allows one poller
  per token, so the ear is opened once, in `index.ts`, and both halves are dispatched from it.

### Changed

- `missing` asks its question only of the things that act on their own, and only when the hour
  is reliably theirs. It names the groups it applies to -- movement and openings -- rather than
  the ones it skips, so a group added later says nothing until somebody decides its silence
  means something. A person who is not home is out, an air conditioner that is not running was
  switched off, and a problem sensor that is not firing is the good day the house was hoping
  for; all three reported, and none of them described anything anyone could act on. The floor
  under a baseline rose with it, from two per cent of an hour to a quarter: every finding the
  old floor produced from a motion sensor or a door sat between three and seven per cent, which
  is a baseline saying "occasionally", and an hour that is occasionally something is not strange
  for being nothing. Measured over a week in one house: thirteen conditions become one.

- An hour that is *always* busy is no longer missing when it falls quiet. A behavioural baseline
  above three quarters describes a state rather than an event -- a contact sensor on a door that
  stands open, a tracker for a phone that never leaves -- so its going to nothing is that state
  changing, which is ordinary. The first one reported said "usually active for 100% of this hour
  and was not active at all" about a door being shut, and a week of hours found the same kind of
  thing at seventy-seven and eighty-nine per cent. A sensor that has genuinely stopped reporting
  is the `stuck` rule's finding, not this one.

### Fixed

- A message that never arrived was never asked again. Every suggestion row counted against its
  condition, the failed ones included, so ten minutes of a domestic connection being down would
  have made that condition permanently unaskable -- the worst possible outcome for the one rule
  whose whole purpose is getting a question in front of somebody. The record of the attempt is
  kept; only its claim on the condition goes.

## [0.0.1]

The split itself: a voice assistant for a house, with everything that belonged to one
particular house taken out of it. Numbered low on purpose -- this is the version the
repository is built and reviewed at, not the version it is published at. The first public
release will be `1.0.0`, because publishing is the moment the shape of a pack, the house
seam and the websocket protocol become things other people build against.

### Added

- Four knobs on the voice. `JARVIS_VOICE_STABILITY`, `JARVIS_VOICE_SIMILARITY` and
  `JARVIS_VOICE_SPEED` were fixed numbers in the speaking code, which meant the only way to
  make an assistant read evenly rather than perform was to edit a source file. They are
  configuration now, with the previous values as defaults. `JARVIS_VOICE_TIMBRE` is new: how
  far the HUD colours the voice, from the untouched stream at `0` to something closer to a
  machine at `100`. The colouring is a Web Audio chain in the page -- highpass, a presence
  peak, a short comb, a damped tail and a little ring modulation, all scaling off the one
  number -- so the brain streams the same audio either way, no credit is spent on it, and no
  latency is added to a spoken answer. The chain is always built and wired for silence at `0`
  rather than being inserted on demand, because rebuilding an audio graph with buffers already
  scheduled on it clicks in the middle of a sentence.

- A house seam, `HomeProvider` in `shared/src/home.ts`. Six required methods -- what is here,
  what it reads, how to change it, how to be told when it moves -- plus four optional ones
  behind a `capabilities` record: history, statistics, cameras, calendars. Home Assistant is
  the only implementation and stays the recommended one, but nothing above the seam knows that.
  A degradation suite runs the proactive startup, the baselines, the rules and the display
  against a house with none of the four, and says in those terms what is lost: the ten-day
  backfill and the numeric baselines, not a working assistant.

- Packs. Everything beyond talking, remembering and showing something arrives as a directory
  under `packs/`: a manifest, an entry point, a `configured` predicate, and a `create` that
  returns the MCP servers, the tools to pre-approve, its own paragraph of prompt and its own
  health probe. Core ships three -- `home-assistant`, `weather`, `mail` -- in exactly the form
  anyone else would write one. A pack in `packs/local/` shadows a first-party one of the same
  name, which is where a second repository of private packs goes. A pack that throws is dropped
  with a line in the log, one that is not configured is skipped in silence, and a tool call that
  never returns is answered for after a minute.

- A `Delegate` seam, with "nowhere to send it" as the default rather than as a failure. Work too
  big to write here goes to whatever a pack offers; with nothing offered, the verdict is written
  down and said out loud.

- The deployment owns its own identity. `config/persona.md` and `config/seeds/` are ignored by
  this repository, with working examples in `examples/`. `JARVIS_OWNER`, `JARVIS_NOTIFY_ENTITY`,
  `JARVIS_COMMIT_EMAIL`, `JARVIS_GITHUB_REPO` and the three house-map filters
  (`JARVIS_HOUSE_NOISE`, `JARVIS_HOUSE_NOT_A_ROOM`, `JARVIS_HOUSE_VEHICLE`) are environment
  rather than source. The systemd units in `deploy/` are templates that
  `scripts/install-units.sh` fills in; installing enables nothing.

- `docs/operations.md`: the deploy paths, the privilege model, what state exists and for how
  long, what fires on its own, what each dependency looks like when it breaks, and the known
  gaps -- worst first, starting with a control surface that has no authentication of its own.

- A publication check, `scripts/check-no-house-facts.sh`, run in CI. Structural patterns live in
  the script; the household's own words live outside the repository, so the file meant to keep
  them out does not publish them.

### Changed

- The system prompt describes the assistant that actually started. The persona paragraphs about
  the house, the agenda, the weather and the mail live with the packs that provide them, so a
  deployment without Gmail credentials never tells the model it can read the mail.
  `npm run prompt-size` reports what each block and each pack costs per request.

- `show_camera` is registered only when the house says it has cameras. The assistant reads its
  tool list as a list of promises, and a promise that turns out empty halfway through an answer
  has already been made out loud.

- A timezone and locale seam, `shared/src/time.ts`. Every weekday, hour and spoken time is a
  local one, and reasoning about an evening in UTC does not fail -- it quietly answers about a
  different hour. Unset, the machine's own zone is used and said out loud at startup; the
  systemd timers carry the same zone, filled in by `scripts/install-units.sh`.

- Written notice is configurable rather than assumed. `JARVIS_NOTIFY_SERVICE` names the service
  a notify entity is driven with, and `JARVIS_NOTIFY_WEBHOOK` is a second route that needs no
  house at all, with a body template for whatever is on the other end.

- The HUD's own panel measures what it reports. Resident memory, processor share, uptime, disk
  and the duration of the last turn are read from the process every five seconds; a reading
  that cannot be taken renders as an em dash. It previously animated a random walk, which is a
  poor thing to leave in a program whose persona says never to invent a value.

- The hourly self checks read the state of each timer -- installed, enabled, armed -- and treat
  only *enabled but not armed* as a finding, so a deployment that never wanted a job is not
  nagged about it. Half-configured credential pairs are reported by pair, and a house reasoning
  in UTC from its machine's own clock is reported as an invariant.

- `JARVIS_MEMORY_PANEL` ships at `read`. The websocket still drives the house, so this narrows
  the blast radius rather than closing it.

- Two more ways for a deviation to be the wrong question to ask. A finding now has to clear an
  absolute floor in the unit being measured -- three degrees, two tenths of a kilowatt-hour --
  as well as a modified z-score, because a bedroom a degree cooler than most Tuesdays at eight
  is a real statistical outlier and nothing anybody wants to be told about. And a statistic
  whose ordinary hour is negligible, either beside its own weekly swing or in absolute terms,
  is recording events rather than holding a level: a solar counter whose hours run from nothing
  to thousands, a tumble dryer whose meter reads two and a half thousandths of a kilowatt-hour
  in all 168 hours of the week because it never runs at the same hour twice. Measured over the
  first eleven days of detection in one house: 75 deviations become 20. What went were room
  temperatures drifting a degree, disk temperatures drifting three, and ten dryer cycles scored
  at z-scores near four thousand.

### Fixed

- The publication check fails when anything under the five paths a deployment owns is *tracked*
  -- the env file, `config/`, `data/`, `packs/local/` and the denylist. An ignore rule stops
  being consulted the moment git knows about a file, so a single `git add -f` would have
  published one quietly. `data/` matters most and looks most innocent: it holds the memory.

- `.env.example` documents every variable core reads, including the OAuth token it cannot start
  without. It previously listed five, one of which nothing read.

- The engine requirement says Node 22.13 rather than 22. `node:sqlite` needs a flag before that
  and the service does not start without it.

- The publication workflow is skipped outside the repository that owns the secret it needs, so
  a fork does not inherit a permanently red run.
