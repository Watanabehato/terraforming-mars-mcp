import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const mcpUrl = process.env.E2E_MCP_URL ?? 'http://127.0.0.1:8765/mcp';
const tmUrl = (process.env.TM_SERVER_URL ?? 'http://localhost:8888').replace(/\/+$/, '');
const authToken = process.env.E2E_AUTH_TOKEN || process.env.MCP_AUTH_TOKEN || undefined;

type Json = Record<string, unknown>;
type ToolResult = {
  content: Array<{type: string; text?: string}>;
  isError?: boolean;
};

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function asRecord(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function textOf(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const message = asRecord(value).message;
  return typeof message === 'string' ? message : '';
}

async function call(client: Client, name: string, args: Json = {}): Promise<Json> {
  const result = await client.callTool({name, arguments: args}) as unknown as ToolResult;
  const text = result.content
    .map((item) => item.type === 'text' ? item.text ?? '' : '')
    .join('');
  if (result.isError === true) {
    throw new Error(`${name} failed: ${text}`);
  }
  if (text === '') {
    return {};
  }
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new Error(`${name} returned non-JSON text: ${text}`);
  }
}

function cardNames(value: unknown): string[] {
  return asArray<Json>(value)
    .map((card) => card.name)
    .filter((name): name is string => typeof name === 'string');
}

/** Builds a legal response for the simple inputs used by this smoke test. */
function respond(model: Json): Json {
  const type = String(model.type);
  switch (type) {
  case 'initialCards':
  case 'and':
    return {
      type,
      responses: asArray<Json>(model.options).map(respond),
    };
  case 'or': {
    const options = asArray<Json>(model.options);
    const index = typeof model.initial_index === 'number' ? model.initial_index : 0;
    if (options[index] === undefined) {
      throw new Error(`No option at index ${index}.`);
    }
    return {type, index, response: respond(options[index])};
  }
  case 'option':
    return {type};
  case 'card': {
    const min = typeof model.min === 'number' ? model.min : 0;
    return {type, cards: cardNames(model.cards).slice(0, min)};
  }
  case 'amount':
    return {type, amount: typeof model.min === 'number' ? model.min : 0};
  case 'space': {
    const spaces = asArray<string>(model.spaces);
    if (spaces[0] === undefined) {
      throw new Error('No spaces available.');
    }
    return {type, spaceId: spaces[0]};
  }
  case 'player': {
    const players = asArray<string>(model.players);
    if (players[0] === undefined) {
      throw new Error('No players available.');
    }
    return {type, player: players[0]};
  }
  case 'payment':
    return {type, payment: {megacredits: Number(model.amount ?? 0)}};
  case 'projectCard': {
    const names = cardNames(model.cards);
    if (names[0] === undefined) {
      throw new Error('No project cards available.');
    }
    return {type, card: names[0], payment: {megacredits: 0}};
  }
  case 'colony': {
    const colonies = asArray<Json>(model.colonies);
    const name = colonies[0]?.name;
    if (typeof name !== 'string') {
      throw new Error('No colony available.');
    }
    return {type, colonyName: name};
  }
  case 'party': {
    const parties = asArray<string>(model.parties);
    if (parties[0] === undefined) {
      throw new Error('No party available.');
    }
    return {type, partyName: parties[0]};
  }
  case 'delegate': {
    const players = asArray<string>(model.players);
    if (players[0] === undefined) {
      throw new Error('No delegate target available.');
    }
    return {type, player: players[0]};
  }
  case 'resource': {
    const include = asArray<string>(model.include);
    if (include[0] === undefined) {
      throw new Error('No resource available.');
    }
    return {type, resource: include[0]};
  }
  case 'globalEvent': {
    const events = asArray<string>(model.global_events);
    if (events[0] === undefined) {
      throw new Error('No global event available.');
    }
    return {type, globalEventName: events[0]};
  }
  default:
    throw new Error(`The e2e runner does not know how to answer input type "${type}".`);
  }
}

async function main(): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: authToken === undefined ? undefined : {
      headers: {Authorization: `Bearer ${authToken}`},
    },
  });
  const client = new Client({name: 'terraforming-mars-mcp-e2e', version: '0.1.0'});
  await client.connect(transport);
  console.log(`connected to ${mcpUrl}`);

  try {
    const created = await call(client, 'create_game', {
      players: [{name: 'MCP E2E', color: 'red'}],
      expansions: {corpera: true},
      board: 'tharsis',
    });
    const players = asArray<Json>(created.players);
    const player = players[0];
    const playerId = player?.player_id;
    const spectatorId = created.spectator_id;
    if (typeof playerId !== 'string' || typeof spectatorId !== 'string') {
      throw new Error(`create_game returned an unexpected payload: ${JSON.stringify(created)}`);
    }
    console.log(`created game ${String(created.game_id)} as ${playerId} (${String(created.spectator_url)})`);

    await call(client, 'configure_session', {
      player_id: playerId,
      game_id: created.game_id,
    });

    let state = await call(client, 'get_game_state');
    const initialGeneration = Number(asRecord(state.game).generation ?? 0);

    let passed = false;
    for (let step = 0; step < 20 && !passed; step += 1) {
      const turn = await call(client, 'wait_for_turn', {timeout_ms: 30000, poll_ms: 250});
      if (turn.ready !== true) {
        throw new Error(`wait_for_turn timed out: ${JSON.stringify(turn)}`);
      }
      const waiting = asRecord(turn.waiting_for);
      const type = String(waiting.type);
      const options = asArray<Json>(waiting.options);
      const passIndex = type === 'or' ?
        options.findIndex((option) => /pass/i.test(`${textOf(option.title)} ${String(option.button_label ?? '')}`)) :
        -1;

      if (passIndex >= 0) {
        console.log(`passing with option ${passIndex}: ${textOf(options[passIndex].title)}`);
        await call(client, 'choose_option', {index: passIndex});
        passed = true;
        break;
      }

      if (type === 'initialCards') {
        console.log('selecting initial corporation and cards');
        await call(client, 'select_initial_cards', {
          responses: asArray<Json>(waiting.options).map(respond),
        });
      } else if (type === 'or') {
        console.log(`answering setup or input with option 0 (${textOf(options[0]?.title)})`);
        if (options[0] === undefined) {
          throw new Error('The setup or input has no options.');
        }
        await call(client, 'submit_input', {response: respond(waiting)});
      } else {
        console.log(`answering ${type} input`);
        await call(client, 'submit_input', {response: respond(waiting)});
      }

      state = await call(client, 'get_game_state');
    }

    if (!passed) {
      throw new Error('The e2e never reached a Pass action.');
    }

    await call(client, 'wait_for_turn', {timeout_ms: 30000, poll_ms: 250});
    state = await call(client, 'get_game_state');
    const finalGeneration = Number(asRecord(state.game).generation ?? 0);
    if (finalGeneration <= initialGeneration) {
      throw new Error(`Generation did not advance (${initialGeneration} -> ${finalGeneration}).`);
    }

    const playerPage = await fetch(`${tmUrl}/player?id=${encodeURIComponent(playerId)}`, {
      signal: AbortSignal.timeout(10000),
    });
    const spectatorPage = await fetch(`${tmUrl}/spectator?id=${encodeURIComponent(spectatorId)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!playerPage.ok || !spectatorPage.ok) {
      throw new Error(`Web pages failed: player=${playerPage.status}, spectator=${spectatorPage.status}`);
    }

    console.log(JSON.stringify({
      ok: true,
      game_id: created.game_id,
      player_id: playerId,
      spectator_id: spectatorId,
      player_url: players[0]?.player_url,
      spectator_url: created.spectator_url,
      generation_before: initialGeneration,
      generation_after: finalGeneration,
      action: 'pass',
      player_page_status: playerPage.status,
      spectator_page_status: spectatorPage.status,
    }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`E2E FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
