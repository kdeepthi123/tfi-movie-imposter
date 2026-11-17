import { DurableObject } from "cloudflare:workers";
import { BUILTIN_TOPIC, addImages, generateTopic, isBuiltinTopic, lookalikeOptions } from "./topics.js";

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const OPTION_COUNT = 20; // words shown each round: 1 real + 19 look-alikes
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // rooms are wiped after 24h of inactivity
const CACHE_ROOM = "__topic_cache__"; // a special Durable Object that remembers generated topics
const CACHE_DAYS = 3;
const TIMER_CHOICES = [0, 2, 3, 5, 7, 10]; // minutes for the clue round; 0 = no timer

// ---------------------------------------------------------------------------
// Entry worker: static files are served from /public automatically; this only
// handles the API (create room + websocket into a room).
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = String(100000 + Math.floor(Math.random() * 900000));
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch("https://room/create", { method: "POST" });
        if (res.ok) return Response.json({ code });
      }
      return Response.json({ error: "Could not create a room. Try again." }, { status: 503 });
    }

    const m = url.pathname.match(/^\/api\/rooms\/(\d{6})\/ws$/);
    if (m) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// One Durable Object per room. All game secrets live here; each player only
// ever receives their own card, so nobody can peek at the imposter.
// ---------------------------------------------------------------------------
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = null;
    // Answer the phones' heartbeat without waking the room up.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      const stored = (await ctx.storage.get("s")) || null;
      // The built-in list lives in code, so storage keeps `topic: null` for it.
      if (stored) stored.topic = stored.topic || BUILTIN_TOPIC;
      if (stored && !stored.used) Object.assign(stored, { used: [], secretIdx: null, options: [], generating: null });
      if (stored && stored.settings.timerMin == null) stored.settings.timerMin = 5;
      if (stored) stored.generating = null; // a restart interrupts any AI request in progress
      this.s = stored;
    });
  }

  async save() {
    const s = this.s;
    s.lastActive = Date.now();
    const { topic, ...rest } = s;
    await this.ctx.storage.put("s", { ...rest, topic: topic.builtin ? null : topic });
    await this.scheduleAlarm();
  }

  // One alarm does two jobs: end the clue timer, and delete idle rooms.
  async scheduleAlarm() {
    const s = this.s;
    let at = (s.lastActive || Date.now()) + ROOM_TTL_MS;
    if (s.phase === "clues" && s.cluesEndsAt) at = Math.min(at, s.cluesEndsAt);
    await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const s = this.s;
    if (!s) return;
    if (s.phase === "clues" && s.cluesEndsAt && Date.now() >= s.cluesEndsAt - 250) {
      s.phase = "voting";
      s.cluesEndsAt = null;
      await this.save();
      this.broadcast();
      return;
    }
    if (Date.now() >= (s.lastActive || 0) + ROOM_TTL_MS) {
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(4000, "Room expired"); } catch {}
      }
      this.s = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.scheduleAlarm();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Topic cache (only used on the CACHE_ROOM instance)
    if (url.pathname === "/cache/get") {
      const hit = await this.ctx.storage.get("t:" + url.searchParams.get("k"));
      const fresh = hit && Date.now() - hit.at < CACHE_DAYS * 86_400_000;
      return Response.json(fresh ? hit.items : null);
    }
    if (url.pathname === "/cache/put") {
      const { k, items } = await request.json();
      await this.ctx.storage.put("t:" + k, { at: Date.now(), items });
      return new Response("ok");
    }

    if (url.pathname === "/create") {
      if (this.s) return new Response("taken", { status: 409 });
      this.s = {
        hostId: null,
        players: {}, // id -> { id, name, token, score }
        order: [],
        phase: "lobby", // lobby | clues | voting | guess | results
        round: 0,
        settings: { imposterHint: false, timerMin: 5, posterMode: false },
        cluesEndsAt: null, // when the clue timer runs out (ms epoch)
        topic: BUILTIN_TOPIC, // { name, builtin, items: [{ name, detail, tags, hint }] }
        generating: null, // topic name while the AI is working on it
        used: [], // item indexes already used as the secret in this topic
        roundPlayers: [],
        secretIdx: null,
        imposterId: null,
        starterId: null,
        votes: {},
        options: [],
        result: null,
      };
      await this.save();
      return new Response("ok");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: null });
    if (!this.s) {
      server.send(JSON.stringify({ type: "error", code: "NO_ROOM", message: "Room not found. Check the code." }));
      server.close(4004, "Room not found");
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- websocket events ---------------------------------------------------

  async webSocketMessage(ws, raw) {
    if (raw === "ping") { try { ws.send("pong"); } catch {} return; }
    if (!this.s) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const pid = ws.deserializeAttachment()?.pid;

    try {
      if (msg.type === "join") return await this.onJoin(ws, msg);
      if (!pid || !this.s.players[pid]) return this.err(ws, "Join the room first.");
      const handler = {
        start: this.onStart,
        settings: this.onSettings,
        setTopic: this.onSetTopic,
        beginVoting: this.onBeginVoting,
        vote: this.onVote,
        endVoting: this.onEndVoting,
        guess: this.onGuess,
        kick: this.onKick,
        claimHost: this.onClaimHost,
        addTime: this.onAddTime,
        leave: this.onLeave,
      }[msg.type];
      if (!handler) return;
      await handler.call(this, ws, pid, msg);
    } catch (e) {
      this.err(ws, "Something went wrong: " + (e?.message || e));
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
    if (!this.s) return;
    if (this.s.phase === "voting") await this.maybeTally(ws);
    this.broadcast(ws);
  }

  async webSocketError(ws) {
    if (this.s) this.broadcast(ws);
  }

  // ---- handlers -------------------------------------------------------------

  async onJoin(ws, msg) {
    const s = this.s;
    const name = String(msg.name || "").trim().replace(/\s+/g, " ").slice(0, 20);

    // Reconnect with an existing identity
    const existing = msg.playerId && s.players[msg.playerId];
    if (existing && existing.token === msg.token) {
      if (name) existing.name = name;
      ws.serializeAttachment({ pid: existing.id });
      if (!s.hostId) s.hostId = existing.id;
      await this.save();
      ws.send(JSON.stringify({ type: "joined", playerId: existing.id, token: existing.token }));
      return this.broadcast();
    }

    if (!name) return this.err(ws, "Please enter your name.");
    if (s.order.length >= MAX_PLAYERS) return this.err(ws, `Room is full (max ${MAX_PLAYERS}).`, true);
    if (Object.values(s.players).some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return this.err(ws, "That name is taken in this room. Pick another.", true);
    }

    const player = { id: crypto.randomUUID(), token: crypto.randomUUID(), name, score: 0 };
    s.players[player.id] = player;
    s.order.push(player.id);
    if (!s.hostId) s.hostId = player.id;
    ws.serializeAttachment({ pid: player.id });
    await this.save();
    ws.send(JSON.stringify({ type: "joined", playerId: player.id, token: player.token }));
    this.broadcast();
  }

  async onSetTopic(ws, pid, msg) {
    const s = this.s;
    if (pid !== s.hostId) return this.err(ws, "Only the host can change the topic.");
    if (s.phase !== "lobby" && s.phase !== "results") return this.err(ws, "Change the topic between rounds.");
    if (s.generating) return this.err(ws, "Still creating the last topic…");
    const name = String(msg.topic || "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (!name) return this.err(ws, "Type a topic first.");

    if (isBuiltinTopic(name)) {
      s.topic = BUILTIN_TOPIC;
      s.used = [];
      await this.save();
      return this.broadcast();
    }

    const cache = this.env.ROOMS.get(this.env.ROOMS.idFromName(CACHE_ROOM));
    const key = "v2 " + name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); // bump "v2" to remake all saved topics
    try {
      const items = await (await cache.fetch("https://cache/cache/get?k=" + encodeURIComponent(key))).json();
      if (items) {
        // No pictures yet (older entry, or the lookup failed last time): try again and re-cache.
        if (!items.some((it) => it.image)) {
          s.generating = name;
          this.broadcast();
          await addImages(items, name);
          s.generating = null;
          await cache.fetch("https://cache/cache/put", { method: "POST", body: JSON.stringify({ k: key, items }) });
        }
        s.topic = { name, builtin: false, items };
        s.used = [];
        await this.save();
        return this.broadcast();
      }
    } catch (e) { console.log("topic cache get failed:", e?.message || e); } // cache is best-effort

    s.generating = name;
    this.broadcast();
    try {
      s.topic = await generateTopic(name, this.env);
      await addImages(s.topic.items, name);
      s.used = [];
      try {
        await cache.fetch("https://cache/cache/put", { method: "POST", body: JSON.stringify({ k: key, items: s.topic.items }) });
      } catch (e) { console.log("topic cache put failed:", e?.message || e); }
    } catch (e) {
      this.err(ws, e?.message || "Couldn't create that topic.");
    } finally {
      s.generating = null;
      await this.save();
      this.broadcast();
    }
  }

  async onStart(ws, pid) {
    const s = this.s;
    if (pid !== s.hostId) return this.err(ws, "Only the host can start.");
    if (s.phase !== "lobby" && s.phase !== "results") return this.err(ws, "A round is already running.");
    if (s.generating) return this.err(ws, "Wait for the topic to finish loading.");
    const online = this.onlineIds();
    const players = s.order.filter((id) => online.has(id));
    if (players.length < MIN_PLAYERS) return this.err(ws, `Need at least ${MIN_PLAYERS} players online.`);

    const items = s.topic.items;
    let pool = items.map((_, i) => i).filter((i) => !s.used.includes(i));
    if (pool.length === 0) { s.used = []; pool = items.map((_, i) => i); }
    s.secretIdx = pick(pool);
    s.used.push(s.secretIdx);
    s.options = lookalikeOptions(items, s.secretIdx, Math.min(OPTION_COUNT, items.length));
    s.roundPlayers = players;
    s.imposterId = pick(players);
    s.starterId = pick(players);
    s.votes = {};
    s.result = null;
    s.round += 1;
    s.phase = "clues";
    const mins = s.settings.timerMin ?? 5;
    s.cluesEndsAt = mins > 0 ? Date.now() + mins * 60_000 : null;
    await this.save();
    this.broadcast();
  }

  async onSettings(ws, pid, msg) {
    if (pid !== this.s.hostId) return;
    if (typeof msg.imposterHint === "boolean") this.s.settings.imposterHint = msg.imposterHint;
    if (TIMER_CHOICES.includes(msg.timerMin)) this.s.settings.timerMin = msg.timerMin;
    if (typeof msg.posterMode === "boolean") this.s.settings.posterMode = msg.posterMode;
    await this.save();
    this.broadcast();
  }

  async onBeginVoting(ws, pid) {
    if (pid !== this.s.hostId || this.s.phase !== "clues") return;
    this.s.phase = "voting";
    this.s.cluesEndsAt = null;
    await this.save();
    this.broadcast();
  }

  async onVote(ws, pid, msg) {
    const s = this.s;
    if (s.phase !== "voting") return;
    if (!s.roundPlayers.includes(pid)) return this.err(ws, "You're not in this round.");
    if (msg.target === pid || !s.roundPlayers.includes(msg.target)) return this.err(ws, "Invalid vote.");
    s.votes[pid] = msg.target;
    await this.save();
    await this.maybeTally();
    this.broadcast();
  }

  async onEndVoting(ws, pid) {
    const s = this.s;
    if (pid !== s.hostId || s.phase !== "voting") return;
    if (Object.keys(s.votes).length === 0) return this.err(ws, "Nobody has voted yet.");
    await this.tally();
    this.broadcast();
  }

  async onGuess(ws, pid, msg) {
    const s = this.s;
    if (s.phase !== "guess" || pid !== s.imposterId) return;
    const idx = Number(msg.idx);
    if (!s.options.includes(idx)) return;
    this.finish(idx === s.secretIdx ? "stolen" : "caught", idx);
    await this.save();
    this.broadcast();
  }

  async onKick(ws, pid, msg) {
    const s = this.s;
    if (pid !== s.hostId || s.phase !== "lobby" || msg.target === pid || !s.players[msg.target]) return;
    this.removePlayer(msg.target);
    for (const sock of this.ctx.getWebSockets()) {
      if (sock.deserializeAttachment()?.pid === msg.target) {
        try {
          sock.send(JSON.stringify({ type: "error", code: "KICKED", message: "The host removed you from the room." }));
          sock.close(4001, "Kicked");
        } catch {}
      }
    }
    await this.save();
    this.broadcast();
  }

  async onAddTime(ws, pid) {
    const s = this.s;
    if (pid !== s.hostId || s.phase !== "clues" || !s.cluesEndsAt) return;
    s.cluesEndsAt += 60_000;
    await this.save();
    this.broadcast();
  }

  async onClaimHost(ws, pid) {
    if (this.onlineIds().has(this.s.hostId)) return this.err(ws, "The host is still online.");
    this.s.hostId = pid;
    await this.save();
    this.broadcast();
  }

  async onLeave(ws, pid) {
    const s = this.s;
    const midRound = s.phase !== "lobby" && s.phase !== "results" && s.roundPlayers.includes(pid);
    if (!midRound) this.removePlayer(pid);
    ws.serializeAttachment({ pid: null });
    try { ws.close(1000, "Left"); } catch {}
    if (s.hostId === pid) s.hostId = [...this.onlineIds(ws)].find((id) => s.players[id]) || s.order[0] || null;
    await this.save();
    this.broadcast(ws);
  }

  // ---- game logic -----------------------------------------------------------

  async maybeTally(closingWs) {
    const s = this.s;
    if (s.phase !== "voting") return;
    const online = this.onlineIds(closingWs);
    const needed = s.roundPlayers.filter((id) => online.has(id));
    if (needed.length > 0 && needed.every((id) => s.votes[id])) await this.tally();
  }

  async tally() {
    const s = this.s;
    const counts = {};
    for (const t of Object.values(s.votes)) counts[t] = (counts[t] || 0) + 1;
    const max = Math.max(0, ...Object.values(counts));
    const top = Object.keys(counts).filter((id) => counts[id] === max);
    const caught = top.length === 1 && top[0] === s.imposterId;

    if (caught) s.phase = "guess";
    else this.finish(top.length > 1 ? "tie" : "escaped", null);
    await this.save();
  }

  // outcome: escaped | tie | stolen | caught
  finish(outcome, guessIdx) {
    const s = this.s;
    const imposterWins = outcome !== "caught";
    if (imposterWins) {
      if (s.players[s.imposterId]) s.players[s.imposterId].score += 2;
    } else {
      for (const id of s.roundPlayers) if (id !== s.imposterId && s.players[id]) s.players[id].score += 1;
    }
    const counts = {};
    for (const t of Object.values(s.votes)) counts[t] = (counts[t] || 0) + 1;
    const items = s.topic.items;
    // Snapshot names now, so changing the topic on the results screen can't scramble them.
    s.result = {
      outcome,
      winner: imposterWins ? "imposter" : "crew",
      imposterId: s.imposterId,
      imposterName: s.players[s.imposterId]?.name || "Someone who left",
      topicName: s.topic.name,
      secret: { name: items[s.secretIdx].name, detail: items[s.secretIdx].detail, image: items[s.secretIdx].image || null },
      guess: guessIdx == null ? null : items[guessIdx].name,
      options: s.options.map((i) => ({ name: items[i].name, image: items[i].image || null, real: i === s.secretIdx, guessed: i === guessIdx })),
      counts,
      votes: { ...s.votes },
    };
    s.phase = "results";
  }

  removePlayer(id) {
    const s = this.s;
    delete s.players[id];
    s.order = s.order.filter((x) => x !== id);
    if (s.hostId === id) s.hostId = s.order[0] || null;
  }

  // ---- views ----------------------------------------------------------------

  onlineIds(excludeWs) {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludeWs) continue;
      const pid = ws.deserializeAttachment()?.pid;
      if (pid) ids.add(pid);
    }
    return ids;
  }

  viewFor(pid, online) {
    const s = this.s;
    const inRound = s.roundPlayers.includes(pid);
    const live = s.phase === "clues" || s.phase === "voting" || s.phase === "guess";
    const items = s.topic.items;

    let card = null;
    if (inRound && live && s.secretIdx != null) {
      const secret = items[s.secretIdx];
      card = pid === s.imposterId
        ? { role: "imposter", hint: s.settings.imposterHint ? secret.hint : null }
        : { role: "crew", secret: { name: secret.name, detail: secret.detail, image: secret.image || null, idx: s.secretIdx } };
    }

    return {
      type: "state",
      you: pid,
      hostId: s.hostId,
      hostOnline: online.has(s.hostId),
      phase: s.phase,
      round: s.round,
      settings: s.settings,
      minPlayers: MIN_PLAYERS,
      topic: { name: s.topic.name, builtin: Boolean(s.topic.builtin), count: items.length, pics: items.filter((it) => it.image).length },
      generating: s.generating,
      players: s.order.map((id) => ({
        id,
        name: s.players[id].name,
        score: s.players[id].score,
        online: online.has(id),
        inRound: live || s.phase === "results" ? s.roundPlayers.includes(id) : true,
        voted: s.phase === "voting" ? Boolean(s.votes[id]) : false,
      })),
      inRound,
      starterId: live ? s.starterId : null,
      // Remaining time rather than a timestamp, so phones with a wrong clock still count down correctly.
      timerMs: s.phase === "clues" && s.cluesEndsAt ? Math.max(0, s.cluesEndsAt - Date.now()) : null,
      timerChoices: TIMER_CHOICES,
      card,
      myVote: s.votes[pid] || null,
      imposterId: s.phase === "guess" || s.phase === "results" ? s.imposterId : null,
      // The 20 possible answers. Everyone in the round sees the same list; it never says which is real.
      options: inRound && live ? s.options.map((i) => ({ idx: i, name: items[i].name, detail: items[i].detail, image: items[i].image || null })) : null,
      result: s.phase === "results" ? s.result : null,
    };
  }

  broadcast(excludeWs) {
    const online = this.onlineIds(excludeWs);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludeWs) continue;
      const pid = ws.deserializeAttachment()?.pid;
      if (!pid || !this.s.players[pid]) continue;
      try { ws.send(JSON.stringify(this.viewFor(pid, online))); } catch {}
    }
  }

  err(ws, message, fatal = false) {
    try {
      ws.send(JSON.stringify({ type: "error", code: fatal ? "JOIN_FAILED" : "ERROR", message }));
    } catch {}
  }
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
