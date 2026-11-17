const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const el = {
  home: $("#home"), room: $("#room"), name: $("#name"), code: $("#code"),
  create: $("#create"), join: $("#join"), leave: $("#leave"), codeBtn: $("#codeBtn"),
  stage: $("#stage"), players: $("#players"), conn: $("#conn"), toast: $("#toast"), announce: $("#announce"),
};

let ws = null;
let roomCode = null;
let state = null;
let revealed = false;
let marks = {}; // option idx -> "yes" | "no" (this player's private notes for the round)
let lastAnnounce = "";
let retry = 0;
let retryTimer = null;
let intentionalClose = false;

// ---------- persistence ----------
el.name.value = localStorage.getItem("tfi:name") || "";
const sessionKey = (code) => `tfi:room:${code}`;
const getSession = (code) => JSON.parse(localStorage.getItem(sessionKey(code)) || "null");

// ---------- home ----------
const params = new URLSearchParams(location.search);
if (/^\d{6}$/.test(params.get("room") || "")) {
  el.code.value = params.get("room");
  if (getSession(params.get("room"))) enterRoom(params.get("room"));
}

el.code.addEventListener("input", () => (el.code.value = el.code.value.replace(/\D/g, "").slice(0, 6)));
el.code.addEventListener("keydown", (e) => e.key === "Enter" && el.join.click());
el.name.addEventListener("keydown", (e) => e.key === "Enter" && (el.code.value ? el.join : el.create).click());

function needName() {
  const n = el.name.value.trim();
  if (!n) { toast("Enter your name first."); el.name.focus(); return null; }
  localStorage.setItem("tfi:name", n);
  return n;
}

el.create.addEventListener("click", async () => {
  if (!needName()) return;
  el.create.disabled = true;
  try {
    const res = await fetch("/api/rooms", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not create room");
    enterRoom(data.code);
  } catch (e) {
    toast(e.message);
  } finally {
    el.create.disabled = false;
  }
});

el.join.addEventListener("click", () => {
  if (!needName()) return;
  if (!/^\d{6}$/.test(el.code.value)) { toast("Room codes are 6 digits."); el.code.focus(); return; }
  enterRoom(el.code.value);
});

el.leave.addEventListener("click", () => {
  if (!confirm("Leave this room?")) return;
  send({ type: "leave" });
  localStorage.removeItem(sessionKey(roomCode));
  exitRoom();
});

el.codeBtn.addEventListener("click", async () => {
  const url = `${location.origin}/?room=${roomCode}`;
  const text = `Join my TFI Movie Imposter game! Code ${roomCode}`;
  try {
    if (navigator.share) await navigator.share({ title: "TFI Movie Imposter", text, url });
    else { await navigator.clipboard.writeText(url); toast("Invite link copied!"); }
  } catch {}
});

// ---------- connection ----------
function enterRoom(code) {
  roomCode = code;
  state = null;
  revealed = false;
  history.replaceState(null, "", `/?room=${code}`);
  el.home.hidden = true;
  el.room.hidden = false;
  el.codeBtn.textContent = code;
  el.stage.innerHTML = `<div class="panel center"><p>Connecting…</p></div>`;
  el.players.innerHTML = "";
  connect();
}

function exitRoom() {
  intentionalClose = true;
  clearTimeout(retryTimer);
  try { ws?.close(); } catch {}
  ws = null;
  roomCode = null;
  state = null;
  history.replaceState(null, "", "/");
  el.room.hidden = true;
  el.home.hidden = false;
  el.code.value = "";
}

function connect() {
  intentionalClose = false;
  clearTimeout(retryTimer);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/api/rooms/${roomCode}/ws`);
  ws = sock;
  setConn("Connecting…", "wait");

  sock.onopen = () => {
    retry = 0;
    setConn("Live", "ok");
    const sess = getSession(roomCode) || {};
    sock.send(JSON.stringify({ type: "join", name: el.name.value.trim() || localStorage.getItem("tfi:name"), ...sess }));
  };

  sock.onmessage = (ev) => {
    if (ev.data === "pong") return;
    const msg = JSON.parse(ev.data);
    if (msg.type === "joined") {
      localStorage.setItem(sessionKey(roomCode), JSON.stringify({ playerId: msg.playerId, token: msg.token }));
    } else if (msg.type === "state") {
      const newRound = !state || state.round !== msg.round;
      if (newRound) { revealed = false; marks = {}; }
      state = msg;
      timerEnd = msg.timerMs != null ? Date.now() + msg.timerMs : null;
      render();
    } else if (msg.type === "error") {
      toast(msg.message);
      if (["NO_ROOM", "KICKED", "JOIN_FAILED"].includes(msg.code)) {
        localStorage.removeItem(sessionKey(roomCode));
        exitRoom();
      }
    }
  };

  sock.onclose = () => {
    if (ws !== sock || intentionalClose || !roomCode) return;
    setConn("Reconnecting…", "wait");
    retry = Math.min(retry + 1, 6);
    retryTimer = setTimeout(connect, 400 * 2 ** retry);
  };
}

// Phones drop sockets when the screen locks; reconnect when the user comes back.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && roomCode && (!ws || ws.readyState > 1)) connect();
});

// Heartbeat: quiet connections (e.g. during a 5-minute clue round) get closed by the network otherwise.
setInterval(() => { if (ws?.readyState === 1) ws.send("ping"); }, 30_000);

function send(obj) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
  else toast("Not connected — reconnecting…");
}

// ---------- rendering ----------
function render() {
  const s = state;
  const me = s.players.find((p) => p.id === s.you);
  const isHost = s.you === s.hostId;
  const name = (id) => esc(s.players.find((p) => p.id === id)?.name || "Someone");

  // players list
  el.players.innerHTML = [...s.players]
    .sort((a, b) => b.score - a.score)
    .map((p) => {
      const badges = [
        p.id === s.hostId ? `<span class="badge host" title="Host">👑 host</span>` : "",
        p.id === s.you ? `<span class="badge you">you</span>` : "",
        s.phase === "voting" && p.inRound ? (p.voted ? `<span class="badge ok">voted</span>` : `<span class="badge">thinking…</span>`) : "",
        !p.inRound ? `<span class="badge">next round</span>` : "",
      ].join("");
      const kick = isHost && s.phase === "lobby" && p.id !== s.you
        ? `<button class="btn small ghost" data-kick="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>` : "";
      return `<li class="${p.online ? "" : "offline"}">
        <span class="dot" aria-hidden="true"></span>
        <span class="pname">${esc(p.name)}<span class="sr-only">${p.online ? "" : " (offline)"}</span></span>
        ${badges}
        <span class="score" aria-label="${p.score} points">${p.score}</span>
        ${kick}
      </li>`;
    })
    .join("");

  const hostTakeover = !s.hostOnline && !isHost
    ? `<button class="btn small" data-act="claimHost">Host is offline — take over</button>` : "";
  const noun = s.topic.builtin ? "movie" : "word";

  let html = "";
  let say = "";

  if (s.phase === "lobby") {
    const online = s.players.filter((p) => p.online).length;
    say = "Waiting in lobby";
    html = topicHtml(s, isHost) + `<div class="panel center">
      <p class="big">Waiting for players</p>
      <p class="muted">${online} online · ${s.minPlayers}–10 players</p>
      <p class="muted">Tap the room code above to invite friends.</p>
      ${isHost ? `
        <label class="toggle"><input type="checkbox" data-setting="imposterHint" ${s.settings.imposterHint ? "checked" : ""}/> Give the imposter a small hint</label>
        ${hasPictures(s) ? `<label class="toggle"><input type="checkbox" data-setting="posterMode" ${s.settings.posterMode ? "checked" : ""}/> 🖼️ ${s.topic.builtin ? "Poster mode (posters instead of titles)" : `Picture mode (pictures instead of names, ${s.topic.pics} of ${s.topic.count} have one)`}</label>` : ""}
        <label class="toggle" for="timerSel">⏱️ Clue timer
          <select id="timerSel" data-setting="timerMin">${s.timerChoices.map((m) =>
            `<option value="${m}" ${m === s.settings.timerMin ? "selected" : ""}>${m ? `${m} min` : "Off"}</option>`).join("")}</select>
        </label>
        <button class="btn primary" data-act="start" ${online < s.minPlayers || s.generating ? "disabled" : ""}>Start game</button>`
      : `<p>Waiting for ${name(s.hostId)} to start…</p>${hostTakeover}`}
    </div>`;
  }

  if (s.phase === "clues" || s.phase === "voting") {
    html += cardHtml(s, noun);
  }

  if (s.phase === "clues") {
    say = `Round ${s.round}. ${s.starterId === s.you ? "You start" : name(s.starterId) + " starts"} giving clues.`;
    html += `<div class="panel center">
      <p class="label">Round ${s.round} · Clues · ${esc(s.topic.name)}</p>
      <p class="big">🎤 ${s.starterId === s.you ? "You start!" : `${name(s.starterId)} starts`}</p>
      ${s.timerMs != null ? `<p class="timer" id="timer" role="timer" aria-label="Time left for clues">--:--</p>` : ""}
      <p class="muted">Go around the circle. Give one clue each about the ${noun} — don't say it!${s.timerMs != null ? " Voting opens automatically when time runs out." : ""}</p>
      ${isHost ? `${s.timerMs != null ? `<button class="btn small ghost" data-act="addTime">+1 minute</button>` : ""}
        <button class="btn primary" data-act="beginVoting">Everyone's done — start voting</button>` : hostTakeover}
    </div>`;
  }

  if (s.phase === "voting") {
    const voters = s.players.filter((p) => p.inRound);
    const done = voters.filter((p) => p.voted).length;
    say = "Voting is open.";
    html += `<div class="panel">
      <p class="label">Round ${s.round} · Vote</p>
      <p class="big">Who's the imposter?</p>
      <p class="muted" aria-live="polite">${done} / ${voters.length} voted${s.myVote ? " · you can change your vote until everyone's in" : ""}</p>
      ${s.inRound ? `<div class="grid">${voters.filter((p) => p.id !== s.you).map((p) =>
        `<button class="btn vote ${s.myVote === p.id ? "selected" : ""}" data-vote="${p.id}" aria-pressed="${s.myVote === p.id}">${esc(p.name)}</button>`).join("")}</div>`
      : `<p>You'll join next round.</p>`}
      ${isHost ? `<button class="btn small ghost" data-act="endVoting">Reveal now (skip missing votes)</button>` : hostTakeover}
    </div>`;
  }

  // The 20 options go below the timer / voting panel so those stay visible without scrolling.
  if (s.phase === "clues" || s.phase === "voting") html += optionsHtml(s, noun);

  if (s.phase === "guess") {
    const imp = s.imposterId === s.you;
    say = imp ? `You were caught! Guess the ${noun} to steal the win.` : `${name(s.imposterId)} was caught and is guessing the ${noun}.`;
    html = (imp ? "" : cardHtml(s, noun)) + `<div class="panel center">
      <p class="big">🚨 ${imp ? "You were caught!" : `${name(s.imposterId)} was the imposter!`}</p>
      ${imp ? `<p>Guess the ${noun} correctly to steal the win:</p>
        <div class="tiles ${tilesClass(s)}">${s.options.map((o) => tileHtml(s, o, `data-guess="${o.idx}" data-name="${esc(o.name)}"`, "")).join("")}</div>`
      : `<p class="muted">They get one guess at the ${noun} to steal the win…</p>`}
    </div>`;
  }

  if (s.phase === "results") {
    const r = s.result;
    const crewWin = r.winner === "crew";
    const why = {
      caught: `${esc(r.imposterName)} was caught and guessed “${esc(r.guess)}” — wrong!`,
      stolen: `${esc(r.imposterName)} was caught but guessed it right — stolen!`,
      escaped: `The crew voted out the wrong person.`,
      tie: `The vote was tied, so the imposter slipped away.`,
    }[r.outcome];
    const votes = s.players
      .filter((p) => r.counts[p.id])
      .sort((a, b) => r.counts[b.id] - r.counts[a.id])
      .map((p) => `<li>${esc(p.name)}${p.id === r.imposterId ? " 🕵️" : ""}: <strong>${r.counts[p.id]}</strong> vote${r.counts[p.id] > 1 ? "s" : ""}
        <span class="muted">(${Object.entries(r.votes).filter(([, t]) => t === p.id).map(([v]) => name(v)).join(", ")})</span></li>`)
      .join("");
    say = `${crewWin ? "Crew wins" : "Imposter wins"}. The answer was ${r.secret.name}. ${r.imposterName} was the imposter.`;
    html = `<div class="panel center result ${crewWin ? "crew" : "imp"}">
      <p class="big">${crewWin ? "🎉 Crew wins!" : "🕵️ Imposter wins!"}</p>
      <p>${why}</p>
      <p>Imposter: <strong>${esc(r.imposterName)}</strong></p>
      <p>Answer: <strong>${esc(r.secret.name)}</strong>${r.secret.detail ? ` (${esc(r.secret.detail)})` : ""}</p>
      ${votes ? `<ul class="votes">${votes}</ul>` : ""}
      <p class="label">The ${r.options.length} possible answers · ${esc(r.topicName)}</p>
      <ul class="tiles ${tilesClass(s)} static">${r.options.map((o) =>
        `<li class="tile ${o.real ? "real" : o.guessed ? "wrong" : ""}">
          ${usePosters(s) && o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy" />` : ""}
          <span class="tname">${esc(o.name)}${o.real ? " ✅" : o.guessed ? " ❌ guess" : ""}</span></li>`).join("")}</ul>
      ${isHost ? `<button class="btn primary" data-act="start" ${s.generating ? "disabled" : ""}>Next round 🎬</button>` : `<p class="muted">Waiting for ${name(s.hostId)} to start the next round…</p>${hostTakeover}`}
    </div>` + topicHtml(s, isHost);
  }

  // Keep anything the host has typed (and focus) when other players' updates re-render the screen.
  const focusedId = document.activeElement?.closest?.("#stage") ? document.activeElement.id : null;
  const caret = focusedId ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  el.stage.querySelectorAll("[data-keep]").forEach((n) => (drafts[n.id] = n.tagName === "DETAILS" ? n.open : n.value));
  el.stage.innerHTML = html;
  el.stage.querySelectorAll("[data-keep]").forEach((n) => {
    if (!(n.id in drafts)) return;
    if (n.tagName === "DETAILS") n.open = drafts[n.id]; else n.value = drafts[n.id];
  });
  const f = focusedId && document.getElementById(focusedId);
  if (f) { f.focus(); try { f.setSelectionRange(...caret); } catch {} }
  if (s.generating) say = `Creating the topic ${s.generating} with AI`;
  if (say && say !== lastAnnounce) { el.announce.textContent = say; lastAnnounce = say; }
  if (me && !me.online) setConn("Reconnecting…", "wait");
  tickTimer();
}

// ---------- clue timer ----------
let timerEnd = null;
let lastSpoken = null;
function tickTimer() {
  const t = $("#timer");
  if (!t || timerEnd == null) return;
  const left = Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000));
  t.textContent = left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Time's up!";
  t.classList.toggle("low", left <= 30);
  // Screen readers: announce at 1 minute and 10 seconds, not every second.
  const mark = left === 60 ? "1 minute left" : left === 10 ? "10 seconds left" : null;
  if (mark && mark !== lastSpoken) { el.announce.textContent = mark; lastSpoken = mark; }
}
setInterval(tickTimer, 1000);

const PRESETS = [
  "Telugu movies", "Telugu actors", "Telugu comedians", "Cities in AP & Telangana",
  "Indian celebrities", "Jobs & professions", "Places (spa, pool, temple…)", "Indian foods",
];

function topicHtml(s, isHost) {
  const t = s.topic;
  return `<section class="panel topic" aria-labelledby="topic-title">
    <p class="label" id="topic-title">Topic</p>
    <p class="big">${t.builtin ? "🎬" : "✨"} ${esc(t.name)}</p>
    <p class="muted small">${t.count} words · ${t.builtin ? "built-in list" : "made by AI"}</p>
    ${s.generating ? `<p class="generating" role="status"><span class="spinner" aria-hidden="true"></span> Creating “${esc(s.generating)}” with AI… about 30–60 seconds the first time (it's instant next time)</p>` : ""}
    ${isHost ? `<form id="topicForm" class="topic-form">
        <label for="topicInput">Change topic — type anything and free AI makes the words</label>
        <div class="row">
          <input id="topicInput" data-keep maxlength="80" autocomplete="off" placeholder="e.g. Cities in Telangana" ${s.generating ? "disabled" : ""} />
          <button class="btn small primary" type="submit" ${s.generating ? "disabled" : ""}>Use</button>
        </div>
        <div class="chips" role="group" aria-label="Topic ideas">
          ${PRESETS.map((p) => `<button type="button" class="chip" data-topic="${esc(p)}" ${s.generating ? "disabled" : ""}>${esc(p)}</button>`).join("")}
        </div>
      </form>` : ""}
  </section>`;
}

function cardHtml(s, noun) {
  if (!s.inRound || !s.card) return `<div class="panel center"><p>A round is in progress. You'll be dealt in next round.</p></div>`;
  const c = s.card;
  const face = c.role === "imposter"
    ? `<p class="role imp">🕵️ You are the IMPOSTER</p>
       <p>Blend in. Listen to the clues and figure out the ${noun}.</p>
       ${c.hint ? `<p class="hint">Hint: ${esc(c.hint)}</p>` : ""}`
    : `<p class="role">${s.topic.builtin ? "🎬 Your movie" : "🔑 Your secret word"}</p>
       ${usePosters(s) && c.secret.image ? `<img class="card-poster" src="${esc(c.secret.image)}" alt="" />` : ""}
       <p class="movie">${esc(c.secret.name)}</p>
       ${c.secret.detail ? `<p class="muted">${esc(c.secret.detail)}</p>` : ""}`;
  return `<div class="card ${revealed ? "shown" : ""} ${c.role === "imposter" && revealed ? "imp" : ""}">
    <p class="label">${esc(s.topic.name)}</p>
    ${revealed ? face : `<p class="role">Your secret card</p><p class="muted">Make sure nobody's looking at your screen.</p>`}
    <button class="btn ${revealed ? "ghost" : "primary"}" data-act="reveal" aria-pressed="${revealed}">${revealed ? "Hide card" : "Tap to reveal"}</button>
  </div>`;
}

// Picture mode is offered when most words have a picture (words without one show their name).
function hasPictures(s) {
  return s.topic.builtin || (s.topic.pics || 0) >= Math.ceil(s.topic.count * 0.6);
}
function tilesClass(s) {
  return usePosters(s) ? (s.topic.builtin ? "posters" : "posters photos") : "";
}
function usePosters(s) {
  return s.settings.posterMode && hasPictures(s);
}

// One option: poster (no title) in poster mode, otherwise the name. Shows the player's own ✓/✗ mark.
function tileHtml(s, o, attrs, extraClass) {
  const poster = usePosters(s) && o.image;
  const mark = marks[o.idx];
  const markText = mark === "yes" ? ", marked possible" : mark === "no" ? ", marked ruled out" : "";
  return `<button type="button" class="tile ${extraClass} ${mark || ""} ${poster ? "has-img" : ""}" ${attrs} aria-label="${esc(o.name)}${markText}">
    ${poster ? `<img src="${esc(o.image)}" alt="" loading="lazy" />` : `<span class="tname">${esc(o.name)}${o.detail ? ` <small>${esc(o.detail)}</small>` : ""}</span>`}
    ${mark ? `<span class="mark" aria-hidden="true">${mark === "yes" ? "✓" : "✗"}</span>` : ""}
  </button>`;
}

function optionsHtml(s, noun) {
  if (!s.inRound || !s.options?.length) return "";
  const mine = revealed && s.card?.role === "crew" ? s.card.secret.idx : null;
  return `<section class="panel" aria-labelledby="opts-title">
    <h3 id="opts-title">Possible ${noun}s (${s.options.length})</h3>
    <p class="muted small">One of these is the real ${noun}. Tap to mark <strong>✓ possible</strong>, tap again for <strong>✗ ruled out</strong>, again to clear. Only you see your marks.</p>
    <div class="tiles ${tilesClass(s)}">${s.options.map((o) => tileHtml(s, o, `data-mark="${o.idx}"`, o.idx === mine ? "real" : "")).join("")}</div>
    ${usePosters(s) ? `<p class="muted small credit">${s.topic.builtin ? "Posters" : "Pictures"}: Wikipedia</p>` : ""}
  </section>`;
}

// ---------- actions ----------
const drafts = {};
el.room.addEventListener("submit", (e) => {
  e.preventDefault();
  if (e.target.id === "topicForm") {
    const input = $("#topicInput");
    const topic = input.value.trim();
    if (!topic) { toast("Type a topic first."); return; }
    send({ type: "setTopic", topic });
    input.value = drafts.topicInput = "";
  }
});

el.room.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  if (b.dataset.topic) { send({ type: "setTopic", topic: b.dataset.topic }); return; }
  if (b.dataset.mark) {
    const i = b.dataset.mark;
    marks[i] = marks[i] === "yes" ? "no" : marks[i] === "no" ? undefined : "yes";
    render();
    document.querySelector(`[data-mark="${i}"]`)?.focus();
    return;
  }
  if (b.dataset.act === "reveal") { revealed = !revealed; render(); $("[data-act=reveal]")?.focus(); return; }
  if (b.dataset.act) return send({ type: b.dataset.act });
  if (b.dataset.vote) return send({ type: "vote", target: b.dataset.vote });
  if (b.dataset.guess) { if (confirm(`Final answer: ${b.dataset.name}?`)) send({ type: "guess", idx: Number(b.dataset.guess) }); return; }
  if (b.dataset.kick && confirm("Remove this player?")) send({ type: "kick", target: b.dataset.kick });
});

el.room.addEventListener("change", (e) => {
  if (e.target.dataset.setting === "imposterHint") send({ type: "settings", imposterHint: e.target.checked });
  if (e.target.dataset.setting === "posterMode") send({ type: "settings", posterMode: e.target.checked });
  if (e.target.dataset.setting === "timerMin") send({ type: "settings", timerMin: Number(e.target.value) });
});

// ---------- ui helpers ----------
function setConn(text, kind) {
  el.conn.textContent = text;
  el.conn.dataset.kind = kind;
}

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 3500);
}
