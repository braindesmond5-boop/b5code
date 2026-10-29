// The agents a thread can run on. Each one is a session class with the same
// methods and events (server/session.js is the reference): send, warm,
// interrupt, answerPermission, setModel, close, and "event" and "exit". What an
// agent can't do is listed in `caps`, and the page hides it for that thread.
//
//   steer    a message sent mid-turn steers it (otherwise it waits for its turn)
//   effort   a thinking-effort setting
//   usage    plan limits to show
//   accounts several signed-in accounts
//   ask      its questions can be answered in the page

import { ClaudeSession } from "./session.js";
import { OpenCodeSession, findOpenCode, listOpenCodeModels } from "./opencode.js";

export const PROVIDERS = {
  claude: {
    id: "claude", name: "Claude Code",
    caps: { steer: true, effort: true, usage: true, accounts: true, ask: true },
    installed: () => true, // B5 Code is built on it; a missing one says so when a thread starts
    install: "",
    models: async () => [], // Claude's come from Claude Code itself (the page's own list)
    create: (opts) => new ClaudeSession(opts),
  },
  opencode: {
    id: "opencode", name: "OpenCode",
    caps: { steer: false, effort: false, usage: false, accounts: false, ask: false },
    installed: () => !!findOpenCode(),
    install: "npm i -g opencode-ai",
    models: listOpenCodeModels,
    create: (opts) => new OpenCodeSession(opts),
  },
};

export const DEFAULT_PROVIDER = "claude";

/** The agent a thread runs on: Claude for any thread from before there was a choice. */
export const providerOf = (thread) => (PROVIDERS[thread?.provider] ? thread.provider : DEFAULT_PROVIDER);

/** For the page: each agent, whether it's installed, and what it can do. */
export const listProviders = () => Object.values(PROVIDERS).map(({ id, name, caps, installed, install }) => ({ id, name, caps, install, installed: installed() }));

const MODELS_TTL = 60 * 1000;
const MODELS_RETRY = 10 * 1000; // an empty answer (it failed, or wasn't ready): not asked again for a moment, or every menu opened would start the program again
const modelCache = new Map(); // provider id -> { at, list } or { pending }

/**
 * An agent's models, looked up at most once a minute (the lookup starts the
 * agent's program, and takes seconds). Calls while one is running share it.
 * `now` is for tests.
 */
export function providerModels(id, now = Date.now()) {
  const p = PROVIDERS[id];
  if (!p || !p.installed()) return Promise.resolve([]);
  const hit = modelCache.get(id);
  if (hit?.pending) return hit.pending;
  if (hit && now - hit.at < (hit.list.length ? MODELS_TTL : MODELS_RETRY)) return Promise.resolve(hit.list);
  const pending = Promise.resolve(p.models()).catch(() => []).then((list) => {
    modelCache.set(id, { at: now, list });
    return list;
  });
  modelCache.set(id, { pending });
  return pending;
}

/** listProviders() with each installed agent's models, for the page's menu. */
export const providersWithModels = async () => Promise.all(listProviders().map(async (p) => ({ ...p, models: p.installed ? await providerModels(p.id) : [] })));

export const createSession = (provider, opts) => PROVIDERS[provider].create(opts);
