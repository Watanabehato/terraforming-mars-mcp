import type {TmCard, TmGameModel, TmInputModel, TmPlayerModel, TmPublicPlayer, TmSpace} from './tm.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ?
    value as Record<string, unknown> : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  const message = asRecord(value).message;
  return typeof message === 'string' ? message : undefined;
}

function paymentOptionsOf(value: unknown): string[] {
  return Object.entries(asRecord(value))
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key);
}

function cardResourcesOf(input: TmInputModel): Record<string, number> | undefined {
  const resources: Record<string, number> = {};
  for (const key of ['seeds', 'auroraiData', 'kuiperAsteroids', 'spireScience', 'floaters', 'microbes', 'graphene', 'lunaArchivesScience']) {
    const value = input[key];
    if (typeof value === 'number' && value > 0) {
      resources[key] = value;
    }
  }
  return Object.keys(resources).length > 0 ? resources : undefined;
}

export function compactCard(card: TmCard): Record<string, unknown> {
  const compact: Record<string, unknown> = {name: card.name};
  if (typeof card.calculatedCost === 'number') {
    compact.cost = card.calculatedCost;
  }
  if (typeof card.resources === 'number') {
    compact.resources = card.resources;
  }
  if (card.isDisabled === true) {
    compact.disabled = true;
  }
  return compact;
}

export function inputOptions(input: TmInputModel): TmInputModel[] {
  return asArray<TmInputModel>(input.options);
}

export function compactInput(input: TmInputModel): Record<string, unknown> {
  const compact: Record<string, unknown> = {type: input.type};
  const title = textOf(input.title);
  if (title !== undefined) {
    compact.title = title;
  }
  if (typeof input.buttonLabel === 'string') {
    compact.button_label = input.buttonLabel;
  }
  if (input.optional === true) {
    compact.optional = true;
  }
  const warning = textOf(input.warning);
  if (warning !== undefined) {
    compact.warning = warning;
  }

  switch (input.type) {
  case 'or':
  case 'and':
  case 'initialCards':
    compact.options = inputOptions(input).map(compactInput);
    if (typeof input.initialIdx === 'number') {
      compact.initial_index = input.initialIdx;
    }
    break;
  case 'option':
    break;
  case 'card':
    compact.min = input.min;
    compact.max = input.max;
    compact.cards = asArray<TmCard>(input.cards).map(compactCard);
    break;
  case 'projectCard':
    compact.cards = asArray<TmCard>(input.cards).map(compactCard);
    compact.payment_options = paymentOptionsOf(input.paymentOptions);
    compact.card_resources = cardResourcesOf(input);
    break;
  case 'payment':
    compact.amount = input.amount;
    compact.payment_options = paymentOptionsOf(input.paymentOptions);
    compact.reserve_units = input.reserveUnits ?? null;
    compact.card_resources = cardResourcesOf(input);
    break;
  case 'player':
  case 'delegate':
    compact.players = input.players;
    break;
  case 'space':
    compact.spaces = input.spaces;
    break;
  case 'amount':
    compact.min = input.min;
    compact.max = input.max;
    compact.max_by_default = input.maxByDefault === true;
    break;
  case 'colony':
    compact.colonies = asArray<Record<string, unknown>>(input.coloniesModel).map((colony) => ({
      name: colony.name,
      is_active: colony.isActive === true,
      track_position: colony.trackPosition,
      colonies: colony.colonies,
    }));
    break;
  case 'party':
    compact.parties = input.parties;
    break;
  case 'productionToLose':
    compact.pay_production = input.payProduction;
    break;
  case 'aresGlobalParameters':
    compact.ares_data = input.aresData;
    break;
  case 'globalEvent':
    compact.global_events = input.globalEventNames;
    break;
  case 'resource':
    compact.include = input.include;
    break;
  case 'resources':
    compact.count = input.count;
    break;
  case 'claimedUndergroundToken':
    compact.min = input.min;
    compact.max = input.max;
    compact.tokens = input.tokens;
    break;
  case 'deltaProject':
    compact.valid_steps = input.validSteps;
    break;
  default:
    compact.raw = input;
    break;
  }
  return compact;
}

function productionOf(player: TmPublicPlayer): Record<string, number> {
  return {
    megacredits: player.megacreditProduction,
    steel: player.steelProduction,
    titanium: player.titaniumProduction,
    plants: player.plantProduction,
    energy: player.energyProduction,
    heat: player.heatProduction,
  };
}

function resourcesOf(player: TmPublicPlayer): Record<string, number> {
  return {
    megacredits: player.megacredits,
    steel: player.steel,
    titanium: player.titanium,
    plants: player.plants,
    energy: player.energy,
    heat: player.heat,
  };
}

function compactPlayer(player: TmPublicPlayer, includePrivateCounts: boolean): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    name: player.name,
    color: player.color,
    terraform_rating: player.terraformRating,
    resources: resourcesOf(player),
    production: productionOf(player),
    cards_in_hand: player.cardsInHandNbr,
    played_cards: player.tableau.length,
    is_active: player.isActive === true,
    cities: player.citiesCount,
    colonies: player.coloniesCount,
    fleet: player.fleetSize,
    influence: player.influence,
    tags: player.tags,
    victory_points: player.victoryPointsBreakdown?.total,
  };
  if (includePrivateCounts) {
    compact.actions_taken_this_generation = player.actionsThisGeneration;
    compact.available_blue_card_actions = player.availableBlueCardActionCount;
  }
  return compact;
}

function compactExpansions(game: TmGameModel): string[] {
  return Object.entries(game.gameOptions?.expansions ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key);
}

function compactGame(game: TmGameModel, players: TmPublicPlayer[]): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    name: game.name,
    generation: game.generation,
    phase: game.phase,
    step: game.step,
    game_age: game.gameAge,
    undo_count: game.undoCount,
    active_player: players.find((player) => player.isActive)?.color,
    passed_players: game.passedPlayers,
    globals: {
      temperature: game.temperature,
      oxygen: game.oxygenLevel,
      oceans: game.oceans,
      venus: game.venusScaleLevel,
    },
    is_terraformed: game.isTerraformed,
    is_solo_win: game.isSoloModeWin,
    expansions: compactExpansions(game),
    deck: {
      project_draw: game.deckSize,
      project_discard: game.discardPileSize,
    },
    spectator_id: game.spectatorId,
  };
  if (game.phase === 'end') {
    compact.milestones = compactMilestones(game);
    compact.awards = compactAwards(game);
  }
  return compact;
}

function compactMilestones(game: TmGameModel): unknown[] {
  return asArray<Record<string, unknown>>(game.milestones).map((milestone) => ({
    name: milestone.name,
    claimed_by: milestone.playerName ?? null,
    color: milestone.color ?? null,
  }));
}

function compactAwards(game: TmGameModel): unknown[] {
  return asArray<Record<string, unknown>>(game.awards).map((award) => ({
    name: award.name,
    funded_by: award.playerName ?? null,
    color: award.color ?? null,
  }));
}

function compactSpace(space: TmSpace): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    id: space.id,
    space_type: space.spaceType,
  };
  if (space.tileType !== undefined) {
    compact.tile = space.tileType;
  }
  if (space.color !== undefined) {
    compact.owner = space.color;
  }
  if (space.coOwner !== undefined) {
    compact.co_owner = space.coOwner;
  }
  if (space.bonus !== undefined && space.bonus.length > 0) {
    compact.bonus = space.bonus;
  }
  if (space.cube !== undefined) {
    compact.cube = space.cube;
  }
  return compact;
}

export function compactState(
  player: TmPlayerModel,
  publicUrl: string,
  gameId: string | undefined,
): Record<string, unknown> {
  return {
    game_id: gameId ?? null,
    player_id: player.id,
    color: player.color,
    name: player.thisPlayer.name,
    player_url: `${publicUrl}/player?id=${encodeURIComponent(player.id)}`,
    spectator_url: `${publicUrl}/spectator?id=${encodeURIComponent(player.game.spectatorId)}`,
    game: compactGame(player.game, player.players),
    you: compactPlayer(player.thisPlayer, true),
    opponents: player.players
      .filter((opponent) => opponent.color !== player.color)
      .map((opponent) => compactPlayer(opponent, false)),
    hand_count: player.cardsInHand.length,
    request_id: player.requestId ?? null,
    waiting_for: player.waitingFor === undefined ? null : compactInput(player.waitingFor),
    hint: player.waitingFor === undefined ?
      'No input is currently requested. Use wait_for_turn.' :
      'Use an action tool or submit_input with the matching response.',
  };
}

export function compactHand(player: TmPlayerModel): Record<string, unknown> {
  return {
    count: player.cardsInHand.length,
    cards: player.cardsInHand.map(compactCard),
  };
}

export function compactPlayed(player: TmPlayerModel): Record<string, unknown> {
  return {
    count: player.thisPlayer.tableau.length,
    cards: player.thisPlayer.tableau.map(compactCard),
    self_replicating_robots: asArray<TmCard>(player.thisPlayer.selfReplicatingRobotsCards).map(compactCard),
  };
}

export function compactOpponentsPlayed(player: TmPlayerModel): Record<string, unknown> {
  return {
    opponents: player.players
      .filter((opponent) => opponent.color !== player.color)
      .map((opponent) => ({
        player: opponent.name,
        color: opponent.color,
        count: opponent.tableau.length,
        cards: opponent.tableau.map(compactCard),
      })),
  };
}

export function compactBoard(player: TmPlayerModel): Record<string, unknown> {
  const game = player.game;
  return {
    generation: game.generation,
    phase: game.phase,
    active_player: player.players.find((row) => row.isActive)?.color,
    passed_players: game.passedPlayers,
    globals: {
      temperature: game.temperature,
      oxygen: game.oxygenLevel,
      oceans: game.oceans,
      venus: game.venusScaleLevel,
    },
    spaces: game.spaces.map(compactSpace),
    milestones: compactMilestones(game),
    awards: compactAwards(game),
    colonies: asArray<Record<string, unknown>>(game.colonies).map((colony) => ({
      name: colony.name,
      is_active: colony.isActive === true,
      track_position: colony.trackPosition,
      colonies: colony.colonies,
      visitor: colony.visitor ?? null,
    })),
    turmoil: game.turmoil ?? null,
    moon: game.moon ?? null,
    pathfinders: game.pathfinders ?? null,
    ares: game.aresData ?? null,
    deck: {
      project_draw: game.deckSize,
      project_discard: game.discardPileSize,
      other: game.otherDeckSizes,
    },
  };
}
