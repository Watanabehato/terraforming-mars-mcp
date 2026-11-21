export type JsonObject = Record<string, unknown>;

export interface TmCard {
  name: string;
  calculatedCost?: number;
  resources?: number;
  isDisabled?: boolean;
  [key: string]: unknown;
}

export interface TmInputModel {
  type: string;
  title?: unknown;
  buttonLabel?: string;
  optional?: boolean;
  warning?: unknown;
  [key: string]: unknown;
}

export interface TmPublicPlayer {
  name: string;
  color: string;
  id?: string;
  isActive?: boolean;
  terraformRating: number;
  megacredits: number;
  steel: number;
  titanium: number;
  plants: number;
  energy: number;
  heat: number;
  megacreditProduction: number;
  steelProduction: number;
  titaniumProduction: number;
  plantProduction: number;
  energyProduction: number;
  heatProduction: number;
  cardsInHandNbr: number;
  tableau: TmCard[];
  tags?: Record<string, number>;
  actionsTakenThisRound?: number;
  actionsTakenThisGame?: number;
  actionsThisGeneration?: string[];
  availableBlueCardActionCount?: number;
  citiesCount?: number;
  coloniesCount?: number;
  fleetSize?: number;
  influence?: number;
  noTagsCount?: number;
  cardDiscount?: number;
  cardCost?: number;
  steelValue?: number;
  titaniumValue?: number;
  selfReplicatingRobotsCards?: TmCard[];
  victoryPointsBreakdown?: {total?: number; [key: string]: unknown};
  [key: string]: unknown;
}

export interface TmSpace {
  id: string;
  spaceType?: string;
  bonus?: string[];
  color?: string;
  tileType?: string;
  cube?: unknown;
  coOwner?: string;
  [key: string]: unknown;
}

export interface TmGameModel {
  name: string;
  generation: number;
  phase: string;
  step: number;
  gameAge: number;
  undoCount: number;
  passedPlayers: string[];
  temperature: number;
  oxygenLevel: number;
  oceans: number;
  venusScaleLevel: number;
  isTerraformed?: boolean;
  isSoloModeWin?: boolean;
  spectatorId: string;
  spaces: TmSpace[];
  milestones?: Array<Record<string, unknown>>;
  awards?: Array<Record<string, unknown>>;
  colonies?: Array<Record<string, unknown>>;
  turmoil?: unknown;
  moon?: unknown;
  pathfinders?: unknown;
  aresData?: unknown;
  deckSize?: number;
  discardPileSize?: number;
  otherDeckSizes?: unknown;
  lastSoloGeneration?: number;
  gameOptions?: {expansions?: Record<string, boolean>; [key: string]: unknown};
  [key: string]: unknown;
}

export interface TmPlayerModel {
  id: string;
  color: string;
  requestId?: string;
  autopass?: boolean;
  thisPlayer: TmPublicPlayer;
  players: TmPublicPlayer[];
  cardsInHand: TmCard[];
  dealtCorporationCards?: TmCard[];
  dealtPreludeCards?: TmCard[];
  dealtProjectCards?: TmCard[];
  dealtCeoCards?: TmCard[];
  pickedCorporationCard?: TmCard[];
  preludeCardsInHand?: TmCard[];
  waitingFor?: TmInputModel;
  game: TmGameModel;
}

export interface TmSimpleGameModel {
  id: string;
  spectatorId: string;
  name: string;
  activePlayer: string;
  phase: string;
  players: Array<{name: string; color: string; id: string}>;
  gameOptions?: {expansions?: Record<string, boolean>};
  [key: string]: unknown;
}

export interface TmWaitingForModel {
  result: 'GO' | 'WAIT' | 'REFRESH';
  waitingFor: string[];
}

export class TmHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`Terraforming Mars server returned HTTP ${status} for ${url}: ${body}`);
    this.name = 'TmHttpError';
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serializes outbound TM API calls so many bots cannot stampede the server. */
class Throttle {
  private nextAt = 0;

  async take(intervalMs: number): Promise<void> {
    if (intervalMs <= 0) {
      return;
    }
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + intervalMs;
    if (at > now) {
      await sleep(at - now);
    }
  }
}

const tmThrottle = new Throttle();

export class TmClient {
  constructor(
    public readonly baseUrl: string,
    private readonly minIntervalMs: number,
    private readonly timeoutMs: number,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    await tmThrottle.take(this.minIntervalMs);
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {...init, signal: AbortSignal.timeout(this.timeoutMs)});
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot reach Terraforming Mars server at ${url}: ${detail}`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new TmHttpError(response.status, url, text);
    }
    if (text === '') {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TmHttpError(response.status, url, text);
    }
  }

  public getPlayer(playerId: string): Promise<TmPlayerModel> {
    return this.request<TmPlayerModel>(`/api/player?id=${encodeURIComponent(playerId)}`);
  }

  public getWaitingFor(playerId: string, gameAge: number, undoCount: number): Promise<TmWaitingForModel> {
    const query = `id=${encodeURIComponent(playerId)}&gameAge=${gameAge}&undoCount=${undoCount}`;
    return this.request<TmWaitingForModel>(`/api/waitingfor?${query}`);
  }

  public createGame(body: JsonObject): Promise<TmSimpleGameModel> {
    return this.request<TmSimpleGameModel>('/api/creategame', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
  }

  /** Submits one official InputResponse, injecting the live requestId the server requires. */
  public async submit(playerId: string, entity: JsonObject): Promise<TmPlayerModel> {
    const before = await this.getPlayer(playerId);
    if (before.waitingFor === undefined || before.requestId === undefined) {
      throw new Error('The server is not waiting for input from this player. Call wait_for_turn first.');
    }
    if (this.minIntervalMs > 0) {
      await sleep(this.minIntervalMs);
    }
    const payload = {...entity, requestId: before.requestId};
    return this.request<TmPlayerModel>(`/player/input?id=${encodeURIComponent(playerId)}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
  }
}

export const EXPANSION_KEYS = [
  'corpera', 'promo', 'venus', 'colonies', 'prelude', 'prelude2', 'turmoil',
  'community', 'ares', 'moon', 'pathfinders', 'ceo', 'starwars', 'underworld',
  'deltaProject',
] as const;

export type Expansion = typeof EXPANSION_KEYS[number];

const DEFAULT_EXPANSIONS: Record<Expansion, boolean> = {
  corpera: true,
  promo: false,
  venus: false,
  colonies: false,
  prelude: false,
  prelude2: false,
  turmoil: false,
  community: false,
  ares: false,
  moon: false,
  pathfinders: false,
  ceo: false,
  starwars: false,
  underworld: false,
  deltaProject: false,
};

export const PLAYER_COLORS = [
  'red', 'green', 'yellow', 'blue', 'black', 'purple', 'orange', 'pink', 'turquoise', 'clear',
] as const;

const BOARD_NAMES = new Set([
  'tharsis', 'hellas', 'elysium', 'utopia planitia', 'vastitas borealis nova',
  'terra cimmeria nova', 'amazonis planitia', 'arabia terra', 'vastitas borealis',
  'amazonis p.', 't. cimmeria', 'Hollandia',
]);

export interface CreateGameInput {
  players: Array<{name: string; color?: string; beginner?: boolean; handicap?: number}>;
  expansions?: Record<string, boolean>;
  board?: string;
  draft?: boolean;
  initial_draft?: boolean;
  prelude_draft?: boolean;
  solo_tr?: boolean;
  two_corps?: boolean;
  fast_mode?: boolean;
  starting_corporations?: number;
  starting_preludes?: number;
  starting_ceos?: number;
  turmoil_agenda?: 'Standard' | 'Random' | 'Chairman';
}

export function buildNewGameConfig(input: CreateGameInput): JsonObject {
  if (input.players.length === 0) {
    throw new Error('At least one player is required.');
  }
  if (input.players.length > 6) {
    throw new Error('The official game supports at most 6 players.');
  }
  const colors = input.players.map((player, index) => player.color ?? PLAYER_COLORS[index]);
  if (new Set(colors).size !== colors.length) {
    throw new Error('Player colors must be unique.');
  }
  for (const color of colors) {
    if (!(PLAYER_COLORS as readonly string[]).includes(color)) {
      throw new Error(`Unknown player color "${color}". Valid colors: ${PLAYER_COLORS.join(', ')}`);
    }
  }
  const expansions = {...DEFAULT_EXPANSIONS};
  for (const [key, value] of Object.entries(input.expansions ?? {})) {
    if (!(EXPANSION_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unknown expansion "${key}". Valid expansions: ${EXPANSION_KEYS.join(', ')}`);
    }
    if (typeof value !== 'boolean') {
      throw new Error(`Expansion "${key}" must be a boolean.`);
    }
    expansions[key as Expansion] = value;
  }
  const board = input.board ?? 'tharsis';
  if (!BOARD_NAMES.has(board)) {
    throw new Error(`Unknown board "${board}".`);
  }
  return {
    players: input.players.map((player, index) => ({
      name: player.name,
      color: colors[index],
      beginner: player.beginner ?? false,
      handicap: player.handicap ?? 0,
      first: index === 0,
    })),
    expansions,
    boards: [board],
    seed: 0,
    randomFirstPlayer: true,
    undoOption: false,
    showTimers: false,
    fastModeOption: input.fast_mode ?? false,
    showVP: 'all',
    aresExtremeVariant: false,
    politicalAgendasExtension: input.turmoil_agenda ?? 'Standard',
    solarPhaseOption: false,
    removeNegativeGlobalEventsOption: false,
    modularMA: false,
    draftVariant: input.draft ?? false,
    initialDraft: input.initial_draft ?? false,
    preludeDraftVariant: input.prelude_draft ?? false,
    ceosDraftVariant: false,
    startingCorporations: input.starting_corporations ?? 2,
    shuffleMapOption: false,
    randomMA: 'No randomization',
    includeFanMA: false,
    soloTR: input.solo_tr ?? false,
    customCorporationsList: [],
    bannedCards: [],
    includedCards: [],
    customColoniesList: [],
    customPreludes: [],
    requiresMoonTrackCompletion: false,
    requiresVenusTrackCompletion: false,
    moonStandardProjectVariant: false,
    moonStandardProjectVariant1: false,
    altVenusBoard: false,
    escapeVelocity: undefined,
    twoCorpsVariant: input.two_corps ?? false,
    customCeos: [],
    startingCeos: input.starting_ceos ?? 1,
    startingPreludes: input.starting_preludes ?? 2,
    customMA: undefined,
  };
}

const PAYMENT_KEYS = [
  'megacredits', 'steel', 'titanium', 'heat', 'plants', 'microbes', 'floaters',
  'lunaArchivesScience', 'spireScience', 'seeds', 'auroraiData', 'graphene',
  'kuiperAsteroids',
] as const;

const UNIT_KEYS = ['megacredits', 'steel', 'titanium', 'plants', 'energy', 'heat'] as const;

function normalizeCounts(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, number> {
  if (value === undefined) {
    value = {};
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of keys) {
    const raw = source[key] ?? 0;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      throw new Error(`${label}.${key} must be a non-negative integer.`);
    }
    result[key] = raw;
  }
  return result;
}

export function normalizePayment(value: unknown): Record<string, number> {
  return normalizeCounts(value, PAYMENT_KEYS, 'payment');
}

export function normalizeUnits(value: unknown): Record<string, number> {
  return normalizeCounts(value, UNIT_KEYS, 'units');
}
