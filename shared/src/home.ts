/**
 * The seam between the assistant and a house.
 *
 * Everything JARVIS knows about a building goes through this interface. Home
 * Assistant is the only implementation shipped, and it stays the recommended
 * one -- it already speaks to a thousand integrations, and re-implementing that
 * would be the project's whole life. The interface exists so that the parts
 * which do not care about Home Assistant stop importing it: the memory, the
 * conversation, the voice and the self-development side run on a machine with
 * no smart device in it at all, and until now the observation layer would not
 * compile without a Home Assistant websocket.
 *
 * Two rules kept this small. Anything a *tool* needs, and only a tool, belongs
 * with that tool rather than here -- an adapter is not obliged to evaluate a
 * Jinja template. Anything the *observation* layer needs is here, because that
 * layer is core and must run against any house.
 *
 * The optional members are the ones a second implementation is unlikely to
 * have. They are advertised through `capabilities` rather than by probing for
 * `undefined`, so a caller can say what it will do without a capability before
 * it tries: no history means the ten-day backfill is skipped and the baselines
 * take a fortnight to become useful, rather than never arriving.
 */

/** What an implementation can do beyond the required seven methods. */
export interface HomeCapabilities {
  /** Past states per entity. Buys a running start on behavioural baselines. */
  history: boolean;
  /** Long-term hourly statistics. The only source a numeric baseline has. */
  statistics: boolean;
  /** A still image or stream per camera entity. */
  camera: boolean;
  /** Named calendars with upcoming events. */
  calendar: boolean;
}

/** Nothing but the required six. The starting point for a new adapter. */
export const NO_CAPABILITIES: HomeCapabilities = {
  history: false,
  statistics: false,
  camera: false,
  calendar: false,
};

/**
 * One thing in the house, as the registry and the current state together
 * describe it.
 *
 * `area` and `platform` are what the watchlist selects on, and they are the two
 * fields an adapter is most likely to have to work for. A device class is
 * whatever the system calls the kind of thing this is -- `motion`, `door`,
 * `temperature` -- and null when it does not name one.
 */
export interface HomeEntity {
  id: string;
  /** What a person calls it. Falls back to the id when there is no name. */
  name: string;
  state: string;
  attributes: Record<string, unknown>;
  /** Room, by name rather than by id. Null when it belongs to no room. */
  area: string | null;
  /** Which integration provides it; the most reliable thing to select on. */
  platform: string | null;
  deviceClass: string | null;
  /** Whether the system considers it out of service. */
  disabled: boolean;
  /** What the entity is *for*: `config`, `diagnostic`, or null for the thing itself. */
  category: string | null;
}

/** A state that moved, delivered to a subscriber. */
export interface StateChange {
  entityId: string;
  state: string;
  /** Attributes as last seen in full; a feed may only send what changed. */
  attributes: Record<string, unknown>;
  /** When the state itself last changed. */
  changedAt: Date;
}

/** One past state of one entity. */
export interface HistoryPoint {
  state: string;
  at: Date;
}

/** What kind of number a statistic carries, and therefore how to read it. */
export type StatisticShape = "total" | "measurement";

/**
 * One statistic the house keeps, as it describes itself.
 *
 * A meter reports a total that only rises, and what happened in an hour is the
 * difference between readings; a thermometer reports a value, and what happened
 * in an hour is its mean. Reading the wrong one of the two gives a number that
 * is not wrong so much as meaningless, which is why the shape travels with the
 * id rather than being guessed downstream.
 */
export interface StatisticMeta {
  statisticId: string;
  shape: StatisticShape;
  /** The unit the stored numbers are in, e.g. `kWh` or `°C`. */
  unit: string | null;
  /** The system's own grouping: `energy`, `temperature`, `power`, … */
  unitClass: string | null;
}

/** One hour of one statistic, reduced to the number that means something. */
export interface StatisticPoint {
  /** Start of the hour. */
  at: Date;
  /** The change for a total, the mean for a measurement. */
  value: number;
}

/** Told when the connection to the house comes and goes. */
export interface ConnectionHooks {
  up?: () => void;
  down?: () => void;
}

/**
 * Where a camera still can be fetched, and with what.
 *
 * The headers travel with the url because the credential belongs to the house,
 * not to the display: whoever fetches the image should not have to know that
 * this particular house wants a bearer token and the next one a query string.
 */
export interface CameraStill {
  url: string;
  headers: Record<string, string>;
}

/** A calendar the house knows about. */
export interface HomeCalendar {
  id: string;
  name: string;
}

/**
 * A house, as everything above it is allowed to see one.
 *
 * The required members are the ones nothing works without: what is here, what
 * it reads, how to change it, and how to be told when it moves. Everything else
 * is optional and gated on `capabilities`.
 *
 * `connect` and `close` are on the interface rather than left to a constructor
 * because the observation layer owns the lifetime: it starts the connection
 * when the proactive mode allows it and closes it on shutdown, and it should
 * not have to know that one adapter holds a socket and another holds nothing.
 */
export interface HomeProvider {
  readonly capabilities: HomeCapabilities;

  /** Opens whatever connection this needs. Resolves once the house answers. */
  connect(): Promise<void>;

  /** Releases it again. Must be safe to call without a successful connect. */
  close(): void;

  /** Everything the house knows about, with its current state. */
  listEntities(): Promise<HomeEntity[]>;

  /** One entity, or null when the house has no such thing. */
  getState(id: string): Promise<HomeEntity | null>;

  /**
   * Acts on one entity.
   *
   * `action` is the verb in the house's own vocabulary (`turn_on`,
   * `set_temperature`), and `args` whatever it takes. Deliberately untyped: a
   * safe subset would be a second, worse vocabulary, and the confirmation
   * boundary that decides whether an action may run at all lives above this.
   */
  invoke(id: string, action: string, args?: Record<string, unknown>): Promise<void>;

  /**
   * Watches a fixed set of entities for the life of the connection.
   *
   * The callback is expected to survive a reconnect: an implementation that
   * drops and re-establishes the subscription should deliver the full state
   * again afterwards, so a restart of the house shows up as fresh states rather
   * than as silence.
   */
  subscribe(ids: string[], onChange: (change: StateChange) => void): Promise<void>;

  /** The last state seen for an entity on the live feed, if any. */
  latest(id: string): StateChange | null;

  /** Past states per entity. Present when `capabilities.history`. */
  history?(ids: string[], from: Date, to: Date): Promise<Map<string, HistoryPoint[]>>;

  /** Everything statistics are kept for. Present when `capabilities.statistics`. */
  statisticIds?(): Promise<StatisticMeta[]>;

  /** Hourly values per statistic. Present when `capabilities.statistics`. */
  statistics?(
    metas: StatisticMeta[],
    from: Date,
    to: Date,
  ): Promise<Map<string, StatisticPoint[]>>;

  /** Where a still of this camera can be fetched. Present when `capabilities.camera`. */
  cameraStill?(id: string): CameraStill;

  /**
   * Where this camera's moving picture can be fetched, as an MJPEG stream
   * (`multipart/x-mixed-replace`). Optional even with a camera: without it a
   * live camera is a still that is fetched again.
   */
  cameraStream?(id: string): CameraStill;

  /** The calendars to ask about. Present when `capabilities.calendar`. */
  calendars?(): Promise<HomeCalendar[]>;
}
