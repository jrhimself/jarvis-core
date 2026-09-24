/**
 * The plan: what the HUD is told, what the model is told, what the user hears.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bindingWindow,
  describeReset,
  forgetPlanUsage,
  isLimitMessage,
  limitSentence,
  notePlanEvent,
  notePlanReport,
  notePlanReportAsked,
  onPlanUsage,
  PLAN_REPORT_BACKOFF_MS,
  PLAN_REPORT_INTERVAL_MS,
  planReportDue,
  planContextBlock,
  planUsage,
  spokenHour,
} from "../dist/plan.js";
import { withEnv } from "./helpers.ts";

const NOW = new Date("2026-09-16T12:00:00Z");
/** Two in the morning in Amsterdam, the night after NOW. */
const TONIGHT = 1789603200;

function amsterdam<T>(run: () => T): T {
  return withEnv({ JARVIS_TIMEZONE: "Europe/Brussels", JARVIS_LOCALE: "nl-NL" }, run);
}

test("a rejection names the window, is a hundred percent, and carries the reset", () => {
  forgetPlanUsage();
  const heard: unknown[] = [];
  const stop = onPlanUsage((usage) => heard.push(usage));
  const usage = notePlanEvent(
    { status: "rejected", resetsAt: TONIGHT, rateLimitType: "seven_day", overageStatus: "rejected" },
    NOW,
  );
  stop();
  assert.ok(usage !== null);
  assert.equal(usage.status, "rejected");
  assert.equal(usage.binding, "week");
  assert.deepEqual(usage.week, { utilization: 100, resetsAt: "2026-09-17T00:00:00.000Z" });
  assert.equal(usage.session, null, "nothing has been said about the other window");
  assert.equal(heard.length, 1);
  assert.equal(planUsage(), usage);
});

test("an event about one window keeps what was heard about the other", () => {
  forgetPlanUsage();
  notePlanEvent({ status: "allowed", rateLimitType: "five_hour", utilization: 38, resetsAt: TONIGHT }, NOW);
  const usage = notePlanEvent({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 91 }, NOW);
  assert.ok(usage !== null);
  assert.equal(usage.status, "warning");
  assert.equal(usage.session?.utilization, 38);
  assert.equal(usage.week?.utilization, 91);
  assert.equal(usage.week?.resetsAt, null);
  assert.equal(notePlanEvent({ status: "nonsense" }), null, "an unknown state is not a state");
});

test("the SDK's report fills both windows and is refused when the token may not ask", () => {
  forgetPlanUsage();
  assert.equal(notePlanReport({ rate_limits_available: false, rate_limits: null }), null);
  const usage = notePlanReport(
    {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 38, resets_at: "2026-09-16T15:00:00Z" },
        seven_day: { utilization: 24, resets_at: "2026-09-17T00:00:00Z" },
      },
    },
    NOW,
  );
  assert.ok(usage !== null);
  assert.equal(usage.status, "ok");
  assert.equal(usage.binding, "session", "the fuller window binds");
  assert.deepEqual(bindingWindow(usage), { utilization: 38, resetsAt: "2026-09-16T15:00:00Z" });
});

test("the reset is said in the language being spoken, not the locale's", () => {
  amsterdam(() => {
    assert.equal(describeReset(new Date(TONIGHT * 1000), NOW, "nl"), "2 uur vannacht");
    assert.equal(describeReset(new Date(TONIGHT * 1000), NOW, "en"), "2:00 a.m. tonight");
  });
});

test("the reset is an hour tonight and a weekday later in the week", () => {
  amsterdam(() => {
    // NOW is two in the afternoon in Amsterdam.
    assert.equal(describeReset(new Date(TONIGHT * 1000), NOW), "2 uur vannacht");
    assert.equal(describeReset(new Date("2026-09-16T12:30:00Z"), NOW), "2 uur 30 vanmiddag");
    assert.equal(describeReset(new Date("2026-09-16T18:00:00Z"), NOW), "8 uur vanavond");
    assert.equal(describeReset(new Date("2026-09-17T07:00:00Z"), NOW), "9 uur morgenochtend");
    assert.equal(describeReset(new Date("2026-09-16T22:00:00Z"), NOW), "12 uur vannacht");
    assert.equal(describeReset(new Date("2026-09-19T00:00:00Z"), NOW), "zaterdag 2 uur 's nachts");
    assert.equal(describeReset(new Date("2026-09-19T13:00:00Z"), NOW), "zaterdag 3 uur 's middags");
  });
});

test("other languages get the clock they write, with its suffix", () => {
  withEnv({ JARVIS_TIMEZONE: "Europe/Brussels", JARVIS_LOCALE: "en-US" }, () => {
    assert.equal(spokenHour(new Date(TONIGHT * 1000), NOW), "2:00 AM tonight");
    assert.equal(spokenHour(new Date("2026-09-16T12:30:00Z"), NOW), "2:30 PM this afternoon");
    assert.equal(spokenHour(new Date("2026-09-19T13:00:00Z"), NOW, false), "3:00 PM in the afternoon");
  });
});

test("the model is told past the threshold, in one line that forbids mentioning it", () => {
  forgetPlanUsage();
  notePlanEvent({ status: "allowed", rateLimitType: "seven_day", utilization: 60 }, NOW);
  assert.equal(planContextBlock(planUsage(), 75, NOW), "", "sixty is not worth a word");
  const usage = notePlanEvent({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 87, resetsAt: TONIGHT }, NOW);
  const block = amsterdam(() => planContextBlock(usage, 75, NOW));
  assert.match(block, /^\[Plan usage: the weekly window is at 87%, resets 2 uur vannacht\./);
  assert.match(block, /Never mention this to the user\.\]$/);
  assert.equal(planContextBlock(null, 75, NOW), "");
});

test("the SDK's own limit lines are recognised, and nothing else is", () => {
  assert.equal(isLimitMessage("You've hit your weekly limit · resets 2am (Europe/Brussels)"), true);
  assert.equal(isLimitMessage("You've reached your session limit"), true);
  assert.equal(isLimitMessage("Het is 21 graden."), false);
});

test("the deployment's sentence gets the reset time, or loses the sentence that wanted it", () => {
  forgetPlanUsage();
  const template = "Je zit aan je limiet. Ik kan nu even niets opzoeken. Om {reset} wordt hij weer gereset.";
  const usage = notePlanEvent({ status: "rejected", rateLimitType: "seven_day", resetsAt: TONIGHT }, NOW);
  assert.equal(
    amsterdam(() => limitSentence(template, usage, NOW)),
    "Je zit aan je limiet. Ik kan nu even niets opzoeken. Om 2 uur vannacht wordt hij weer gereset.",
  );
  assert.equal(limitSentence(template, null, NOW), "Je zit aan je limiet. Ik kan nu even niets opzoeken.");
  forgetPlanUsage();
});

test("the plan report is asked for once per interval, and not for an hour after a refusal", () => {
  forgetPlanUsage();
  const t0 = NOW.getTime();
  assert.equal(planReportDue(t0), true);

  notePlanReportAsked(true, t0);
  assert.equal(planReportDue(t0 + PLAN_REPORT_INTERVAL_MS - 1), false);
  assert.equal(planReportDue(t0 + PLAN_REPORT_INTERVAL_MS), true);

  notePlanReportAsked(false, t0);
  assert.equal(planReportDue(t0 + PLAN_REPORT_INTERVAL_MS), false);
  assert.equal(planReportDue(t0 + PLAN_REPORT_BACKOFF_MS), true);

  forgetPlanUsage();
  assert.equal(planReportDue(t0), true);
});
