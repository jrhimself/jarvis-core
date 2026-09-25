/**
 * Posts a ripe anomaly to House Ops for triage.
 *
 * Detection stays here; Telegram is no longer the default destination once a
 * webhook URL is configured. House Ops decides ignore / auto_ok / escalate. Core
 * only delivers the fact and a few flags it already knows (quiet hours, rule,
 * watch group). House-specific presence or alarm state is not invented here.
 */

import type { OpenAnomaly } from "./detect.js";
import { ruleName, say, languageOf } from "./phrases.js";
import { locale } from "@jarvis/shared";

const DELIVERY_TIMEOUT_MS = 15_000;

/** How loud House Ops should treat this, before it decides for itself. */
export type AnomalySeverity = "low" | "medium" | "high";

/** What House Ops is being asked to look at. */
export type HouseOpsEventType = "anomaly" | "alert";

/**
 * JSON body posted to `HOUSE_OPS_WEBHOOK_URL`.
 *
 * Keep this stable: House Ops parses it. Optional hints are omitted rather than
 * sent as null, so a missing field means "Core does not know".
 */
export interface HouseOpsAnomalyPayload {
  type: HouseOpsEventType;
  entity_ids: string[];
  event: string;
  severity: AnomalySeverity;
  /** Hint for House Ops: prefer a human ping over silent triage. */
  escalate: boolean;
  timestamp: string;
  /** True when the local clock is inside the configured quiet window. */
  sleep: boolean;
  rule: string;
  subject: string;
  watch_group: string;
  area: string | null;
  buckets: number;
  /** Short plain sentence, no HTML. */
  message: string;
  detail: string;
  suggestion_id: number;
  anomaly_id: number;
  camera_hint?: string;
  nas_hint?: string;
}

/** Watch groups that should wake someone when they fire during quiet hours or otherwise. */
const ESCALATE_GROUPS = new Set(["openings", "safety", "problems", "presence"]);

/** Rules that are already a fault rather than a statistical curiosity. */
const HIGH_RULES = new Set(["problem", "heartbeat", "invariant"]);

function language(): string {
  return languageOf(locale());
}

/** Plain text for the webhook; HTML belongs only on the Telegram path. */
export function plainMessage(anomaly: OpenAnomaly, lang = language()): string {
  const where = anomaly.area === null ? "" : ` · ${anomaly.area}`;
  const held = anomaly.buckets === 1 ? "first hour" : `${anomaly.buckets} hours`;
  const body = say(anomaly.phrase, lang, anomaly.detail);
  return `${ruleName(anomaly.rule, lang)}${where}: ${body} (held ${held})`;
}

/**
 * Severity and escalate from what Core already has on the row.
 *
 * Quiet hours raise escalate so House Ops can still ping for openings/safety even
 * though Core will not Telegram by default. No house alarm or person-presence
 * snapshot is available on this path, so those flags are simply absent.
 */
export function classify(anomaly: OpenAnomaly, sleep: boolean): {
  type: HouseOpsEventType;
  severity: AnomalySeverity;
  escalate: boolean;
} {
  const high = HIGH_RULES.has(anomaly.rule) || ESCALATE_GROUPS.has(anomaly.watchGroup);
  const severity: AnomalySeverity = high ? "high" : "medium";
  const escalate = high || sleep;
  return {
    type: high ? "alert" : "anomaly",
    severity,
    escalate,
  };
}

/** Optional camera / storage hints from entity id shape alone, never from a household name. */
export function optionalHints(anomaly: OpenAnomaly): {
  camera_hint?: string;
  nas_hint?: string;
} {
  const subject = anomaly.subject.toLowerCase();
  const out: { camera_hint?: string; nas_hint?: string } = {};
  if (subject.startsWith("camera.") || subject.includes("_camera") || subject.includes(".camera_")) {
    out.camera_hint = "camera";
  }
  if (
    subject.includes("disk") ||
    subject.includes("synology") ||
    subject.includes("_nas") ||
    subject.includes(".nas_") ||
    anomaly.detail.toLowerCase().includes("disk usage")
  ) {
    out.nas_hint = "storage";
  }
  return out;
}

/** Builds the JSON body for one ripe anomaly about to leave Core. */
export function buildAnomalyPayload(
  anomaly: OpenAnomaly,
  suggestionId: number,
  sleep: boolean,
  now: Date,
): HouseOpsAnomalyPayload {
  const { type, severity, escalate } = classify(anomaly, sleep);
  return {
    type,
    entity_ids: [anomaly.subject],
    event: anomaly.rule,
    severity,
    escalate,
    timestamp: now.toISOString(),
    sleep,
    rule: anomaly.rule,
    subject: anomaly.subject,
    watch_group: anomaly.watchGroup,
    area: anomaly.area,
    buckets: anomaly.buckets,
    message: plainMessage(anomaly),
    detail: anomaly.detail,
    suggestion_id: suggestionId,
    anomaly_id: anomaly.id,
    ...optionalHints(anomaly),
  };
}

/**
 * POSTs the payload. Returns true only on 2xx.
 *
 * Failures are the caller's business: high-severity rows may fall back to
 * Telegram; others are logged and retried on the next hourly pass.
 */
export async function postHouseOpsWebhook(
  url: string,
  key: string,
  payload: HouseOpsAnomalyPayload,
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (key !== "") {
      headers["authorization"] = `Bearer ${key}`;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`house-ops-webhook: ${response.status} ${response.statusText}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("house-ops-webhook: could not post:", error);
    return false;
  }
}
