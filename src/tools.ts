import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import type {Config} from './config.js';
import {
  TmClient,
  TmHttpError,
  buildNewGameConfig,
  normalizePayment,
  sleep,
  type CreateGameInput,
  type JsonObject,
  type TmPlayerModel,
} from './tm.js';
import {
  compactBoard,
  compactHand,
  compactInput,
  compactOpponentsPlayed,
  compactPlayed,
  compactState,
  inputOptions,
} from './compact.js';
import {normalizeInputResponse, validateRawEntity} from './inputResponses.js';

type TextResult = {
  content: Array<{type: 'text'; text: string}>;
  isError?: boolean;
};

function success(value: unknown): TextResult {
  return {content: [{type: 'text', text: JSON.stringify(value)}]};
}

function errorMessage(error: unknown): string {
  if (error instanceof TmHttpError) {
    return `Terraforming Mars rejected the request (HTTP ${error.status}). Raw server response: ${error.body}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function run(work: () => Promise<unknown>): Promise<TextResult> {
  try {
    return success(await work());
  } catch (error) {
    return {content: [{type: 'text', text: errorMessage(error)}], isError: true};
  }
}

function normalizeHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL "${value}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`URL must use http or https: "${value}".`);
  }
  return value.replace(/\/+$/, '');
}

export class SessionContext {
  public readonly config: Config;
  public tmServerUrl: string;
  public tmPublicUrl: string;
  public playerId?: string;
  public gameId?: string;
  private client: TmClient;

  constructor(config: Config) {
    this.config = config;
    this.tmServerUrl = config.tmServerUrl;
    this.tmPublicUrl = config.tmPublicUrl;
    this.client = this.newClient();
  }

  private newClient(): TmClient {
    return new TmClient(
      this.tmServerUrl,
      this.config.minResponseIntervalMs,
      this.config.tmRequestTimeoutMs,
    );
  }

  public configure(args: {
    player_id?: string;
    tm_server_url?: string;
    tm_public_url?: string;
    game_id?: string;
  }): void {
    if (args.tm_server_url !== undefined) {
      this.tmServerUrl = normalizeHttpUrl(args.tm_server_url);
      this.client = this.newClient();
    }
    if (args.tm_public_url !== undefined) {
      this.tmPublicUrl = normalizeHttpUrl(args.tm_public_url);
    }
    if (args.player_id !== undefined) {
      this.playerId = args.player_id;
    }
    if (args.game_id !== undefined) {
      this.gameId = args.game_id;
    }
  }

  public requirePlayerId(): string {
    if (this.playerId === undefined) {
      throw new Error('No player is bound to this MCP session. Call configure_session with player_id first.');
    }
    return this.playerId;
  }

  public player(): Promise<TmPlayerModel> {
    return this.client.getPlayer(this.requirePlayerId());
  }

  public getWaitingFor(gameAge: number, undoCount: number) {
    return this.client.getWaitingFor(this.requirePlayerId(), gameAge, undoCount);
  }

  public createGame(input: CreateGameInput) {
    return this.client.createGame(buildNewGameConfig(input));
  }

  public submit(entity: JsonObject): Promise<TmPlayerModel> {
    return this.client.submit(this.requirePlayerId(), entity);
  }
}

function submitSummary(player: TmPlayerModel): Record<string, unknown> {
  return {
    ok: true,
    player_id: player.id,
    request_id: player.requestId ?? null,
    game: {
      generation: player.game.generation,
      phase: player.game.phase,
    },
    waiting_for: player.waitingFor === undefined ? null : compactInput(player.waitingFor),
    hint: player.waitingFor === undefined ?
      'Input accepted. The server does not currently request input from this player.' :
      'Input accepted. The server still requests input from this player; inspect waiting_for and submit again.',
  };
}

function compactWait(player: TmPlayerModel, start: number): Record<string, unknown> {
  return {
    ready: true,
    waited_ms: Date.now() - start,
    player_id: player.id,
    request_id: player.requestId ?? null,
    waiting_for: player.waitingFor === undefined ? null : compactInput(player.waitingFor),
    game: {
      generation: player.game.generation,
      phase: player.game.phase,
    },
  };
}

export function registerTools(server: McpServer, ctx: SessionContext): void {
  async function submit(entity: JsonObject): Promise<Record<string, unknown>> {
    return submitSummary(await ctx.submit(entity));
  }

  server.registerTool('configure_session', {
    title: 'Configure MCP session',
    description: 'Bind this MCP session to a Terraforming Mars server and one player. Call this after create_game, using the player_id returned for this bot.',
    inputSchema: {
      player_id: z.string().min(1).optional(),
      tm_server_url: z.string().min(1).optional(),
      tm_public_url: z.string().min(1).optional(),
      game_id: z.string().min(1).optional(),
    },
  }, async (args) => run(async () => {
    ctx.configure(args);
    const player = ctx.playerId === undefined ? undefined : await ctx.player();
    return {
      ok: true,
      tm_server_url: ctx.tmServerUrl,
      tm_public_url: ctx.tmPublicUrl,
      player_id: ctx.playerId ?? null,
      game_id: ctx.gameId ?? null,
      player: player === undefined ? null : {
        name: player.thisPlayer.name,
        color: player.color,
        game_name: player.game.name,
        generation: player.game.generation,
        phase: player.game.phase,
        player_url: `${ctx.tmPublicUrl}/player?id=${encodeURIComponent(player.id)}`,
        spectator_url: `${ctx.tmPublicUrl}/spectator?id=${encodeURIComponent(player.game.spectatorId)}`,
      },
      hint: 'Use wait_for_turn to wait for this player\'s next input.',
    };
  }));

  server.registerTool('create_game', {
    title: 'Create a Terraforming Mars game',
    description: 'Create an official Terraforming Mars game and return every player id plus player/spectator URLs. Each bot then calls configure_session with its own player_id.',
    inputSchema: {
      players: z.array(z.object({
        name: z.string().min(1).max(48),
        color: z.string().min(1).optional(),
        beginner: z.boolean().optional(),
        handicap: z.number().int().min(-20).max(20).optional(),
      })).min(1).max(6),
      expansions: z.record(z.string(), z.boolean()).optional(),
      board: z.string().min(1).optional(),
      draft: z.boolean().optional(),
      initial_draft: z.boolean().optional(),
      prelude_draft: z.boolean().optional(),
      solo_tr: z.boolean().optional(),
      two_corps: z.boolean().optional(),
      fast_mode: z.boolean().optional(),
      starting_corporations: z.number().int().min(1).max(4).optional(),
      starting_preludes: z.number().int().min(0).max(4).optional(),
      starting_ceos: z.number().int().min(0).max(4).optional(),
      turmoil_agenda: z.enum(['Standard', 'Random', 'Chairman']).optional(),
    },
  }, async (args) => run(async () => {
    const input: CreateGameInput = {
      players: args.players,
      expansions: args.expansions,
      board: args.board,
      draft: args.draft,
      initial_draft: args.initial_draft,
      prelude_draft: args.prelude_draft,
      solo_tr: args.solo_tr,
      two_corps: args.two_corps,
      fast_mode: args.fast_mode,
      starting_corporations: args.starting_corporations,
      starting_preludes: args.starting_preludes,
      starting_ceos: args.starting_ceos,
      turmoil_agenda: args.turmoil_agenda,
    };
    const game = await ctx.createGame(input);
    ctx.gameId = game.id;
    return {
      ok: true,
      game_id: game.id,
      game_name: game.name,
      active_player: game.activePlayer,
      phase: game.phase,
      expansions: Object.entries(game.gameOptions?.expansions ?? {})
        .filter(([, enabled]) => enabled === true)
        .map(([key]) => key),
      spectator_id: game.spectatorId,
      spectator_url: `${ctx.tmPublicUrl}/spectator?id=${encodeURIComponent(game.spectatorId)}`,
      players: game.players.map((player) => ({
        name: player.name,
        color: player.color,
        player_id: player.id,
        player_url: `${ctx.tmPublicUrl}/player?id=${encodeURIComponent(player.id)}`,
      })),
      hint: 'Each bot calls configure_session with its own player_id, then wait_for_turn.',
    };
  }));

  server.registerTool('get_game_state', {
    title: 'Get game state',
    description: 'Read a compact agent-oriented summary: generation, phase, globals, your resources, opponents, and the current waiting_for input.',
  }, async () => run(async () => {
    const player = await ctx.player();
    return compactState(player, ctx.tmPublicUrl, ctx.gameId);
  }));

  server.registerTool('wait_for_turn', {
    title: 'Wait for turn',
    description: 'Long-poll the official waitingfor API until this player must provide input, then return the compact waiting_for model. Returns ready=false on timeout.',
    inputSchema: {
      timeout_ms: z.number().int().min(0).max(300000).optional(),
      poll_ms: z.number().int().min(100).max(5000).optional(),
    },
  }, async (args) => run(async () => {
    const start = Date.now();
    const timeout = args.timeout_ms ?? ctx.config.waitDefaultMs;
    const poll = args.poll_ms ?? ctx.config.waitPollMs;
    const deadline = start + timeout;
    let player = await ctx.player();
    let gameAge = player.game.gameAge;
    let undoCount = player.game.undoCount;

    if (player.waitingFor !== undefined && player.waitingFor.optional !== true) {
      return compactWait(player, start);
    }

    let lastResult = 'WAIT';
    let waitingForPlayers: string[] = [];
    while (true) {
      if (player.game.phase === 'end') {
        return {
          ready: false,
          ended: true,
          waited_ms: Date.now() - start,
          game: {generation: player.game.generation, phase: player.game.phase},
          hint: 'The game has ended.',
        };
      }
      if (Date.now() >= deadline) {
        return {
          ready: false,
          ended: false,
          waited_ms: Date.now() - start,
          result: lastResult,
          waiting_for_players: waitingForPlayers,
          game: {generation: player.game.generation, phase: player.game.phase},
          hint: 'Timed out. Call wait_for_turn again to continue waiting.',
        };
      }
      const status = await ctx.getWaitingFor(gameAge, undoCount);
      lastResult = status.result;
      waitingForPlayers = status.waitingFor;
      if (status.result === 'GO') {
        const fresh = await ctx.player();
        return compactWait(fresh, start);
      }
      if (status.result === 'REFRESH') {
        player = await ctx.player();
        gameAge = player.game.gameAge;
        undoCount = player.game.undoCount;
        if (player.waitingFor !== undefined && player.waitingFor.optional !== true) {
          return compactWait(player, start);
        }
      }
      await sleep(Math.min(poll, Math.max(0, deadline - Date.now())));
    }
  }));

  server.registerTool('get_mars_board_state', {
    title: 'Get Mars board state',
    description: 'Read the board: placed tiles, space bonuses, global parameters, milestones, awards, colonies, and expansion state.',
  }, async () => run(async () => {
    return compactBoard(await ctx.player());
  }));

  server.registerTool('get_my_hand_cards', {
    title: 'Get my hand cards',
    description: 'List the cards in this player\'s hand with calculated costs.',
  }, async () => run(async () => {
    return compactHand(await ctx.player());
  }));

  server.registerTool('get_my_played_cards', {
    title: 'Get my played cards',
    description: 'List this player\'s tableau (played project cards and corporations).',
  }, async () => run(async () => {
    return compactPlayed(await ctx.player());
  }));

  server.registerTool('get_opponents_played_cards', {
    title: 'Get opponents\' played cards',
    description: 'List the public tableaus of every opponent.',
  }, async () => run(async () => {
    return compactOpponentsPlayed(await ctx.player());
  }));

  server.registerTool('choose_option', {
    title: 'Choose an option',
    description: 'Respond to an option or or input. With a standalone option input, call without index to confirm. With an or input, index selects a child; if the child is not a plain option, pass its nested response object in response.',
    inputSchema: {
      index: z.number().int().min(0).optional(),
      response: z.record(z.string(), z.unknown()).optional(),
    },
  }, async (args) => run(async () => {
    const player = await ctx.player();
    const input = player.waitingFor;
    if (input === undefined) {
      throw new Error('No input is currently requested from this player.');
    }
    if (input.type === 'option') {
      return submit({type: 'option'});
    }
    if (input.type !== 'or') {
      throw new Error(`The current input is "${input.type}", not "or". Use submit_input or a matching action tool.`);
    }
    if (args.index === undefined) {
      throw new Error('index is required for an "or" input.');
    }
    const options = inputOptions(input);
    const child = options[args.index];
    if (child === undefined) {
      throw new Error(`index ${args.index} is out of range; this input has ${options.length} options.`);
    }
    let nested = args.response;
    if (nested === undefined) {
      if (child.type !== 'option') {
        throw new Error(`Option ${args.index} is a "${child.type}" input. Pass a nested response object in "response".`);
      }
      nested = {type: 'option'};
    }
    return submit({type: 'or', index: args.index, response: nested});
  }));

  server.registerTool('submit_amount', {
    title: 'Submit an amount',
    description: 'Respond to an amount input.',
    inputSchema: {
      amount: z.number().int().min(0),
    },
  }, async (args) => run(async () => submit({type: 'amount', amount: args.amount})));

  server.registerTool('select_cards', {
    title: 'Select cards',
    description: 'Respond to a card input. Use card names from the current waiting_for model.',
    inputSchema: {
      cards: z.array(z.string().min(1)).max(50),
    },
  }, async (args) => run(async () => submit({type: 'card', cards: args.cards})));

  server.registerTool('select_space', {
    title: 'Select a board space',
    description: 'Respond to a space input with one space id from the current waiting_for model.',
    inputSchema: {
      space_id: z.string().min(1),
    },
  }, async (args) => run(async () => submit({type: 'space', spaceId: args.space_id})));

  server.registerTool('select_player', {
    title: 'Select a player',
    description: 'Respond to a player input with a player color from the current waiting_for model.',
    inputSchema: {
      player: z.string().min(1),
    },
  }, async (args) => run(async () => submit({type: 'player', player: args.player})));

  server.registerTool('submit_payment', {
    title: 'Submit payment',
    description: 'Respond to a payment input. Missing payment resources are filled with 0.',
    inputSchema: {
      payment: z.record(z.string(), z.unknown()),
    },
  }, async (args) => run(async () => submit({type: 'payment', payment: normalizePayment(args.payment)})));

  server.registerTool('play_project_card', {
    title: 'Play a project card',
    description: 'Respond to a projectCard input: play a card and pay for it. Missing payment resources are filled with 0.',
    inputSchema: {
      card: z.string().min(1),
      payment: z.record(z.string(), z.unknown()).optional(),
    },
  }, async (args) => run(async () => submit({
    type: 'projectCard',
    card: args.card,
    payment: normalizePayment(args.payment),
  })));

  server.registerTool('select_initial_cards', {
    title: 'Select initial cards',
    description: 'Respond to the top-level initialCards input (corporation, preludes, initial project cards). responses must align with the option order in waiting_for.',
    inputSchema: {
      responses: z.array(z.record(z.string(), z.unknown())).min(1).max(10),
    },
  }, async (args) => run(async () => submit({
    type: 'initialCards',
    responses: args.responses.map((response) => normalizeInputResponse(response)),
  })));

  server.registerTool('submit_input', {
    title: 'Submit an official input response',
    description: 'Submit any modeled official InputResponse. Use this for colony, party, delegate, productionToLose, aresGlobalParameters, globalEvent, resource, resources, claimedUndergroundToken, policy, deltaProject, and nested responses.',
    inputSchema: {
      response: z.record(z.string(), z.unknown()),
    },
  }, async (args) => run(async () => submit(normalizeInputResponse(args.response))));

  server.registerTool('submit_raw_entity', {
    title: 'Submit a raw input entity',
    description: 'Escape hatch for a new upstream input type: submit an arbitrary entity object with a type. The current requestId is injected automatically.',
    inputSchema: {
      entity: z.record(z.string(), z.unknown()),
    },
  }, async (args) => run(async () => submit(validateRawEntity(args.entity))));
}
