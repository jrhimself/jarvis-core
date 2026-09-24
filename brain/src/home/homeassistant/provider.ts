/**
 * Home Assistant, behind the house seam.
 *
 * Everything Home-Assistant-shaped that the core needs lives here: the
 * websocket commands, the registry join that turns three lists into one entity
 * with a room on it, the two shapes a statistic can have, and the REST call
 * that acts on something. Above this line nothing knows any of that.
 *
 * The websocket does the reading, not REST. Statistics have no REST endpoint at
 * all, the registry lists have none either, and the connection has to stay open
 * for the live feed regardless -- so asking over the socket costs nothing extra
 * and skips a round of authentication per call. `invoke` is the exception: a
 * service call over REST fails loudly with a status code, where the socket
 * reports the same failure as a result message nobody was waiting for.
 */

import type {
  CameraStill,
  ConnectionHooks,
  HistoryPoint,
  HomeCalendar,
  HomeCapabilities,
  HomeEntity,
  HomeProvider,
  StateChange,
  StatisticMeta,
  StatisticPoint,
} from "@jarvis/shared";

import { HaSocket } from "./socket.js";

/**
 * Statistic ids per request.
 *
 * Not a protocol limit -- Home Assistant answered all 339 at once in 577 ms.
 * It is about the answer's size: ten days of a hundred ids is 2,3 MB, and
 * holding four of those in turn is easier on a small container than holding one
 * of seven.
 */
const STATISTIC_IDS_PER_REQUEST = 100;

/** Entities per history request. The answer is a diff-free list of every state. */
const HISTORY_IDS_PER_REQUEST = 25;

/** How long a REST call may take before it is given up on. */
const REST_TIMEOUT_MS = 15_000;

/** Everything Home Assistant can do, which is all of it. */
const HA_CAPABILITIES: HomeCapabilities = {
  history: true,
  statistics: true,
  camera: true,
  calendar: true,
};

interface RegistryEntity {
  entity_id: string;
  platform?: string | null;
  area_id?: string | null;
  device_id?: string | null;
  disabled_by?: string | null;
  hidden_by?: string | null;
  entity_category?: string | null;
}

interface RegistryDevice {
  id: string;
  area_id?: string | null;
}

interface RegistryArea {
  area_id: string;
  name: string;
}

interface RawState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

interface RawStatisticMeta {
  statistic_id: string;
  has_sum?: boolean;
  has_mean?: boolean;
  statistics_unit_of_measurement?: string | null;
  display_unit_of_measurement?: string | null;
  unit_class?: string | null;
}

interface RawStatisticPoint {
  start: number;
  end: number;
  mean?: number | null;
  min?: number | null;
  max?: number | null;
  sum?: number | null;
  state?: number | null;
  change?: number | null;
}

/** One state as `history/history_during_period` reports it in minimal form. */
interface RawHistoryPoint {
  /** The state. Null when only attributes changed, which is not a state change. */
  s?: string | null;
  /** Last updated, epoch seconds with a fraction. */
  lu?: number;
}

/** What a registry entry and a state say about one entity, joined. */
function join(
  state: RawState,
  entry: RegistryEntity | undefined,
  areaNames: Map<string, string>,
  deviceAreas: Map<string, string | null>,
): HomeEntity {
  const areaId =
    entry?.area_id ?? (entry?.device_id == null ? null : (deviceAreas.get(entry.device_id) ?? null));
  const deviceClass = state.attributes["device_class"];
  const name = state.attributes["friendly_name"];

  return {
    id: state.entity_id,
    name: typeof name === "string" && name !== "" ? name : state.entity_id,
    state: state.state,
    attributes: state.attributes,
    area: areaId == null ? null : (areaNames.get(areaId) ?? null),
    platform: entry?.platform ?? null,
    deviceClass: typeof deviceClass === "string" ? deviceClass : null,
    disabled: entry?.disabled_by != null,
    category: entry?.entity_category ?? null,
  };
}

/** A house that speaks Home Assistant. */
export class HomeAssistant implements HomeProvider {
  readonly capabilities = HA_CAPABILITIES;

  readonly #url: string;
  readonly #token: string;
  readonly #socket: HaSocket;

  constructor(haUrl: string, token: string, hooks: ConnectionHooks = {}) {
    this.#url = haUrl.replace(/\/+$/, "");
    this.#token = token;
    this.#socket = new HaSocket(haUrl, token, hooks);
  }

  async connect(): Promise<void> {
    await this.#socket.connect();
  }

  close(): void {
    this.#socket.close();
  }

  /**
   * Every entity, with the room it is in.
   *
   * Four requests rather than one because Home Assistant keeps the answer in
   * four places: what exists and what it reads right now (`get_states`), which
   * integration owns it and whether it is disabled (the entity registry), and
   * two more lists to turn a device into an area and an area id into a name.
   * Which integration owns an entity is the difference between a motion sensor
   * on the landing and a camera pointed at the street, and nothing in the
   * entity id says which one it is.
   */
  async listEntities(): Promise<HomeEntity[]> {
    const [registry, devices, areas, states] = await Promise.all([
      this.#socket.request<RegistryEntity[]>({ type: "config/entity_registry/list" }),
      this.#socket.request<RegistryDevice[]>({ type: "config/device_registry/list" }),
      this.#socket.request<RegistryArea[]>({ type: "config/area_registry/list" }),
      this.#socket.request<RawState[]>({ type: "get_states" }),
    ]);

    const areaNames = new Map(areas.map((area) => [area.area_id, area.name]));
    const deviceAreas = new Map(devices.map((device) => [device.id, device.area_id ?? null]));
    const byEntityId = new Map(registry.map((entry) => [entry.entity_id, entry]));

    return states.map((state) => join(state, byEntityId.get(state.entity_id), areaNames, deviceAreas));
  }

  async getState(id: string): Promise<HomeEntity | null> {
    const response = await this.#rest(`/api/states/${encodeURIComponent(id)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Home Assistant returned ${response.status}`);

    const state = (await response.json()) as RawState;
    return join(state, undefined, new Map(), new Map());
  }

  /**
   * Calls a service, with the entity as its target.
   *
   * The action is `domain.service` or a bare service in the entity's own
   * domain, which is how every caller here means it: `light.turn_on` and
   * `turn_on` on a light are the same request.
   */
  async invoke(id: string, action: string, args: Record<string, unknown> = {}): Promise<void> {
    const domain = action.includes(".") ? action.split(".")[0]! : (id.split(".")[0] ?? "");
    const service = action.includes(".") ? action.slice(action.indexOf(".") + 1) : action;

    const response = await this.#rest(`/api/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify({ entity_id: id, ...args }),
    });
    if (!response.ok) {
      throw new Error(`${domain}.${service} on ${id} returned ${response.status}`);
    }
  }

  async subscribe(ids: string[], onChange: (change: StateChange) => void): Promise<void> {
    await this.#socket.watch(ids, onChange);
  }

  latest(id: string): StateChange | null {
    return this.#socket.latest(id);
  }

  /**
   * Past states per entity, over the window the recorder still holds.
   *
   * Chunked, and attribute-only updates are dropped here rather than by the
   * caller: a null state is not a change, and the air conditioners produce a
   * great many of them.
   */
  async history(ids: string[], from: Date, to: Date): Promise<Map<string, HistoryPoint[]>> {
    const series = new Map<string, HistoryPoint[]>();

    for (let at = 0; at < ids.length; at += HISTORY_IDS_PER_REQUEST) {
      const chunk = ids.slice(at, at + HISTORY_IDS_PER_REQUEST);
      const answer = await this.#socket.request<Record<string, RawHistoryPoint[]>>({
        type: "history/history_during_period",
        start_time: from.toISOString(),
        end_time: to.toISOString(),
        entity_ids: chunk,
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });

      for (const [entityId, points] of Object.entries(answer)) {
        const kept = points
          .filter(
            (point): point is { s: string; lu: number } =>
              typeof point.s === "string" && typeof point.lu === "number",
          )
          .sort((a, b) => a.lu - b.lu)
          .map((point) => ({ state: point.s, at: new Date(point.lu * 1000) }));
        if (kept.length > 0) series.set(entityId, kept);
      }
    }

    return series;
  }

  /**
   * Everything Home Assistant is keeping statistics on.
   *
   * Note this is metadata and outlives the data: 339 ids are listed here, of
   * which 215 have produced a number in the last two days. The rest are sensors
   * that were excluded from the recorder or integrations that were removed, and
   * their entries stay behind. Anything building on this must check for data
   * rather than trust the list.
   */
  async statisticIds(): Promise<StatisticMeta[]> {
    const raw = await this.#socket.request<RawStatisticMeta[]>({
      type: "recorder/list_statistic_ids",
    });
    return raw.map((entry) => ({
      statisticId: entry.statistic_id,
      shape: entry.has_sum === true ? "total" : "measurement",
      // `unit_of_measurement` is not a field here, whatever the name suggests
      // elsewhere in the API; it is null on every entry.
      unit: entry.statistics_unit_of_measurement ?? entry.display_unit_of_measurement ?? null,
      unitClass: entry.unit_class ?? null,
    }));
  }

  /**
   * Hourly values per statistic over a window, in chunks.
   *
   * Ids that never produced a number are simply absent from the result, which
   * is how a caller tells a dead statistic from a quiet one.
   */
  async statistics(
    metas: StatisticMeta[],
    from: Date,
    to: Date,
  ): Promise<Map<string, StatisticPoint[]>> {
    const shapes = new Map(metas.map((meta) => [meta.statisticId, meta.shape]));
    const series = new Map<string, StatisticPoint[]>();

    for (let at = 0; at < metas.length; at += STATISTIC_IDS_PER_REQUEST) {
      const chunk = metas
        .slice(at, at + STATISTIC_IDS_PER_REQUEST)
        .map((meta) => meta.statisticId);
      const raw = await this.#socket.request<Record<string, RawStatisticPoint[]>>({
        type: "recorder/statistics_during_period",
        start_time: from.toISOString(),
        end_time: to.toISOString(),
        statistic_ids: chunk,
        period: "hour",
      });

      for (const [statisticId, points] of Object.entries(raw)) {
        const shape = shapes.get(statisticId) ?? "measurement";
        const reduced: StatisticPoint[] = [];
        for (const point of points) {
          const value = shape === "total" ? point.change : point.mean;
          if (value === null || value === undefined || !Number.isFinite(value)) continue;
          reduced.push({ at: new Date(point.start), value });
        }
        if (reduced.length > 0) series.set(statisticId, reduced);
      }
    }

    return series;
  }

  /** Where a still of this camera can be fetched, bearer token included. */
  cameraStill(id: string): CameraStill {
    return {
      url: `${this.#url}/api/camera_proxy/${encodeURIComponent(id)}`,
      headers: { Authorization: `Bearer ${this.#token}` },
    };
  }

  /** Where the camera's MJPEG stream can be fetched, bearer token included. */
  cameraStream(id: string): CameraStill {
    return {
      url: `${this.#url}/api/camera_proxy_stream/${encodeURIComponent(id)}`,
      headers: { Authorization: `Bearer ${this.#token}` },
    };
  }

  /** The calendars Home Assistant exposes, in the order it lists them. */
  async calendars(): Promise<HomeCalendar[]> {
    const response = await this.#rest("/api/calendars");
    if (!response.ok) throw new Error(`Home Assistant returned ${response.status}`);

    const raw = (await response.json()) as Array<{ entity_id: string; name?: string }>;
    return raw.map((entry) => ({ id: entry.entity_id, name: entry.name ?? entry.entity_id }));
  }

  #rest(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.#url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
  }
}
