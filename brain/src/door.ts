/**
 * Putting the door on screen because somebody is at it.
 *
 * Everything else that reaches the HUD was asked for: a question is asked, a
 * tool is called, a window goes up inside that turn. A doorbell is the opposite
 * shape. The one thing worth seeing arrives while nobody is talking, it is worth
 * seeing for about as long as it takes to walk to the door, and asking first
 * ("shall I show you the camera?") costs exactly the seconds the picture was
 * for.
 *
 * So this watches a few sensors and pushes a camera, and deliberately does no
 * more than that: no model turn, no speech, nothing remembered. The trigger is
 * an edge, not a state -- a sensor that sits at `on` for ten minutes is one
 * event, not a window that keeps reopening.
 *
 * Which sensor belongs to which camera is a property of a house and not of this
 * program, so it is configuration:
 *
 *     JARVIS_DOOR_WATCH="camera.front=binary_sensor.a,binary_sensor.b"
 *
 * Several cameras are separated by `;`. Pairing by room was the obvious
 * alternative and does not work: a camera and its doorbell routinely belong to
 * no room at all in the registry, and a watch that resolves to nothing is worse
 * than one that was never configured, because it looks configured.
 */

import type { HomeEntity, HomeProvider, StateChange } from "@jarvis/shared";

import { cameraCard } from "./display-tool.js";
import { showUnprompted } from "./live.js";
import { MediaFetchError } from "./media.js";
import { recordScreen } from "./screens.js";

/** One camera and the sensors that mean somebody is in front of it. */
export interface DoorWatch {
  camera: string;
  triggers: string[];
}

/** How long the picture stays up once nobody touches it. */
const ON_SCREEN_MS = 120_000;

/**
 * How long after a trigger the same camera ignores its sensors.
 *
 * A ring is three entities moving at once -- the button, the motion sensor and
 * the person detection -- and the second and third of them arrive while the
 * first one's still is still being fetched.
 */
const COOLDOWN_MS = 15_000;

/**
 * Reads the pairing out of the environment, keeping only what is well formed.
 *
 * Silently dropping a malformed pair would leave a deployment believing it had
 * configured something, so anything rejected is logged with the text that was
 * rejected -- which is an entity id the operator wrote themselves.
 */
export function parseDoorWatch(raw: string | undefined): DoorWatch[] {
  const watches: DoorWatch[] = [];
  for (const group of (raw ?? "").split(";")) {
    const spec = group.trim();
    if (spec === "") continue;

    const [left, right] = spec.split("=");
    const camera = (left ?? "").trim();
    const triggers = (right ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^[a-z_]+\.[a-z0-9_]+$/.test(id));

    if (!/^camera\.[a-z0-9_]+$/.test(camera) || triggers.length === 0) {
      console.error(`door watch: ignoring "${spec}" — expected camera.x=domain.y[,domain.z]`);
      continue;
    }
    watches.push({ camera, triggers: [...new Set(triggers)] });
  }
  return watches;
}

/**
 * Whether a state means somebody is there.
 *
 * A binary sensor says so by reading `on`. An event entity has no state to speak
 * of: its state *is* the timestamp of the last event, so any new readable value
 * is a new press. Both are compared against what was seen before, because the
 * feed replays the current state on subscribe and after every reconnect, and
 * neither of those is somebody at the door.
 */
function isTriggered(entityId: string, state: string, previous: string | undefined): boolean {
  if (previous === undefined) return false;
  if (state === previous) return false;
  if (entityId.startsWith("event.")) return state !== "unknown" && state !== "unavailable";
  return state === "on";
}

/** What to call a camera on screen, without asking the house twice. */
function titleOf(entity: HomeEntity | undefined, cameraId: string): string {
  if (entity !== undefined && entity.name !== "") return entity.name;
  const [, slug = cameraId] = cameraId.split(".");
  const words = slug.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Starts watching, and hands back the way to stop.
 *
 * Stopping cannot unsubscribe -- the seam has no way to -- so it stops acting on
 * what arrives instead, which is what shutdown needs: the socket is closed by
 * whoever opened it a moment later.
 */
export async function startDoorWatch(
  home: HomeProvider,
  watches: DoorWatch[],
): Promise<() => void> {
  if (watches.length === 0) return () => {};
  if (!home.capabilities.camera || home.cameraStill === undefined) {
    console.error("door watch: this house has no cameras to show");
    return () => {};
  }

  const known = new Map((await home.listEntities()).map((entity) => [entity.id, entity]));
  const missing = watches.flatMap((watch) =>
    [watch.camera, ...watch.triggers].filter((id) => !known.has(id)),
  );
  if (missing.length > 0) {
    console.error(`door watch: the house does not have ${missing.join(", ")}`);
  }

  const cameraOf = new Map<string, DoorWatch>();
  for (const watch of watches) {
    for (const trigger of watch.triggers) cameraOf.set(trigger, watch);
  }

  const lastState = new Map<string, string>();
  const lastShown = new Map<string, number>();
  let running = true;

  const show = async (cameraId: string): Promise<void> => {
    // The id is the camera, so a second ring replaces the card rather than
    // stacking another one on top of a picture of the same door.
    const id = `door:${cameraId}`;
    try {
      const payload = await cameraCard(home, cameraId, titleOf(known.get(cameraId), cameraId));
      if (!running) return;
      // Nobody watching is not a failure, but it is not a window either: the log
      // of what was on screen should not claim a picture that went nowhere.
      if (showUnprompted(id, payload, { mode: "timeout", ms: ON_SCREEN_MS })) {
        recordScreen(id, payload);
      }
    } catch (error: unknown) {
      const reason = error instanceof MediaFetchError ? error.message : String(error);
      console.error(`door watch: could not show ${cameraId}: ${reason}`);
    }
  };

  const onChange = (change: StateChange): void => {
    const watch = cameraOf.get(change.entityId);
    const previous = lastState.get(change.entityId);
    lastState.set(change.entityId, change.state);
    if (!running || watch === undefined) return;
    if (!isTriggered(change.entityId, change.state, previous)) return;

    const now = Date.now();
    const since = lastShown.get(watch.camera);
    if (since !== undefined && now - since < COOLDOWN_MS) return;
    lastShown.set(watch.camera, now);

    void show(watch.camera);
  };

  await home.subscribe([...cameraOf.keys()], onChange);
  return () => {
    running = false;
  };
}
