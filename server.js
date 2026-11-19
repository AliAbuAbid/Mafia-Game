// طاولة المافيا — سيرفر الغرف المباشرة
// الشخصيات وكل اختيارات الليل محفوظة على السيرفر. كل لاعب بيوصله اللي إله بس، والحكم بيوصله الكل.
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/health", (_req, res) => res.send("ok"));

// ability: "pick" = بيختار لاعب والاختيار بيروح للحكم، "check" = بيفحص لاعب والحكم بيردّ عليه، "none" = بدون
const DEFAULT_ROLES = [
  { id: "mafia", name: "مافيا", team: "mafia", ability: "none", count: 2, desc: "كل ليلة بتتفقوا مع بعض على لاعب تطلعوه." },
  { id: "inspector", name: "مفتش", team: "town", ability: "check", count: 1, desc: "كل ليلة بتختار لاعب والحكم بيقلك إذا مافيا ولا لأ." },
  { id: "detective", name: "محقق", team: "town", ability: "check", count: 1, desc: "كل ليلة بتحقق بلاعب والحكم بيقلك إذا مافيا ولا لأ." },
  { id: "doctor", name: "دكتور", team: "town", ability: "pick", count: 1, desc: "كل ليلة بتختار لاعب تحميه من المافيا." },
];
const CITIZEN = { name: "مواطن", team: "town", ability: "none", desc: "ما عندك قدرة خاصة. صوّت صح واكشف المافيا." };
const TEAMS = new Set(["mafia", "town", "neutral"]);
const ABILITIES = new Set(["none", "pick", "check"]);
const PHASES = new Set(["night", "day", "vote"]);
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * rooms: code -> {
 *   code, hostId, status: "lobby"|"playing", round, roles,
 *   phase: "night"|"day"|"vote", night,
 *   players: Map(id -> {id, name, out, role, joinedAt}),
 *   actions: Map(playerId -> {targetId, reply}),      // اختيارات الليل للأدوار الخاصة
 *   mafia: {votes: Map(id -> targetId), chat: [], final: {by, targetId} | null},
 *   votes: Map(voterId -> targetId),                    // تصويت النهار
 *   sockets: Map(socketId -> clientId), touched
 * }
 */
const rooms = new Map();

const clean = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const validId = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(s);

function newCode() {
  for (let i = 0; i < 50; i++) {
    let c = "";
    for (let j = 0; j < 5; j++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error("no code");
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function resetNight(room) {
  room.actions = new Map();
  room.mafia = { votes: new Map(), chat: room.mafia ? room.mafia.chat : [], final: null };
}
function resetGame(room) {
  room.phase = "night";
  room.night = 0;
  room.votes = new Map();
  room.mafia = { votes: new Map(), chat: [], final: null };
  room.actions = new Map();
  room.winner = null;      // null | {team: "mafia"|"town", reason}
  room.announce = null;    // آخر واحد انطرد: {seq, id, name, team}
  room.announceSeq = room.announceSeq || 0;
}

/**
 * Has the game been decided?
 * - المدينة بتربح لما ما يضل ولا مافيا.
 * - المافيا بتربح لما عددهم يصير قد عدد الباقيين أو أكثر (بالتصويت ما حدا بيقدر يطلعهم).
 * - والمافيا بتربح كمان إذا الليل جاي وهم ناقصهم لاعب واحد بس عن الباقيين، وما في حدا بيحمي
 *   (الدكتور أو أي شخصية "بتختار"): بالليل رح يطلعوا واحد ويصيروا قدهم، فما في فايدة نكمّل.
 * nextIsNight = الليل هو المرحلة الجاية (يعني الطرد صار بالنهار/التصويت، أو الحكم عم يبلّش ليل).
 */
function computeWinner(room, nextIsNight) {
  const living = [...room.players.values()].filter(alive);
  const m = living.filter((p) => p.role.team === "mafia").length;
  const o = living.length - m;
  if (m === 0) return { team: "town", reason: "انطرد كل المافيا." };
  if (m >= o) return { team: "mafia", reason: `ضلّ ${m} مافيا مقابل ${o} من الباقيين، فما حدا بيقدر يطلعهم بالتصويت.` };
  const protector = living.some((p) => p.role.team !== "mafia" && p.role.ability === "pick");
  if (nextIsNight && m === o - 1 && !protector)
    return { team: "mafia", reason: `ضلّ ${m} مافيا مقابل ${o}، وما في دكتور يحمي. بالليل الجاي المافيا رح يطلعوا واحد ويصيروا قد الباقيين.` };
  return null;
}

const nameOf = (room, id) => room.players.get(id)?.name || "؟";
const alive = (p) => p && !p.out && p.role;

function tally(room) {
  const counts = new Map();
  for (const [voter, target] of room.votes) {
    if (!alive(room.players.get(voter)) || !alive(room.players.get(target))) continue;
    if (!counts.has(target)) counts.set(target, []);
    counts.get(target).push(voter);
  }
  return [...counts.entries()]
    .map(([targetId, voters]) => ({ targetId, name: nameOf(room, targetId), count: voters.length, voters: voters.map((v) => nameOf(room, v)) }))
    .sort((a, b) => b.count - a.count);
}

function mafiaView(room) {
  return {
    votes: [...room.mafia.votes.entries()]
      .filter(([id]) => alive(room.players.get(id)))
      .map(([id, t]) => ({ fromId: id, from: nameOf(room, id), targetId: t, target: nameOf(room, t) })),
    chat: room.mafia.chat.map((m) => ({ from: nameOf(room, m.from), fromId: m.from, text: m.text })),
    final: room.mafia.final ? { by: nameOf(room, room.mafia.final.by), targetId: room.mafia.final.targetId, target: nameOf(room, room.mafia.final.targetId) } : null,
  };
}

function viewFor(room, clientId) {
  const isHost = room.hostId === clientId;
  const online = new Set(room.sockets.values());
  const playing = room.status === "playing";
  const over = playing && !!room.winner;
  const players = [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    out: p.out,
    online: online.has(p.id),
    // الكل بيعرف فريق اللي انطرد (مافيا أو صالح) بس مش شخصيته
    ...(playing && p.out && p.role ? { revealed: p.role.team } : {}),
    // الحكم بيشوف الكل، وبآخر اللعبة الكل بيشوف الكل
    ...((isHost || over) && playing && p.role ? { role: p.role.name, team: p.role.team } : {}),
  }));
  const me = room.players.get(clientId);
  const base = {
    code: room.code, status: room.status, round: room.round, isHost,
    hostOnline: online.has(room.hostId), inRoom: isHost || !!me, meId: clientId,
    roles: isHost ? room.roles : null, players,
    phase: playing ? room.phase : null, night: room.night,
    tally: playing && !over && room.phase === "vote" ? tally(room) : null,
    winner: over ? room.winner : null,
    announce: playing ? room.announce : null,
  };

  if (isHost && playing) {
    base.report = {
      actions: [...room.players.values()]
        .filter((p) => p.role && p.role.team !== "mafia" && p.role.ability !== "none")
        .map((p) => {
          const a = room.actions.get(p.id);
          const t = a && room.players.get(a.targetId);
          return {
            actorId: p.id, actor: p.name, role: p.role.name, ability: p.role.ability, out: p.out,
            targetId: a?.targetId || null, target: t?.name || null,
            targetRole: t?.role?.name || null, targetTeam: t?.role?.team || null, reply: a?.reply || null,
          };
        }),
      mafia: mafiaView(room),
    };
  }

  if (!isHost && me && playing && me.role) {
    const r = me.role;
    const mates = r.team === "mafia"
      ? [...room.players.values()].filter((p) => p.id !== me.id && p.role && p.role.team === "mafia").map((p) => p.name)
      : [];
    base.myRole = { name: r.name, team: r.team, ability: r.team === "mafia" ? "mafia" : r.ability || "none", desc: r.desc || "", mates };
    const a = room.actions.get(me.id);
    base.myAction = a ? { targetId: a.targetId, target: nameOf(room, a.targetId), reply: a.reply || null } : null;
    base.myVote = room.votes.get(me.id) || null;
    if (r.team === "mafia") base.mafia = mafiaView(room);
  } else {
    base.myRole = null;
  }
  return base;
}

function broadcast(room) {
  room.touched = Date.now();
  for (const [sid, cid] of room.sockets) {
    const s = io.sockets.sockets.get(sid);
    if (s) s.emit("state", viewFor(room, cid));
  }
}

function attach(socket, room, clientId) {
  if (socket.data.code && socket.data.code !== room.code) detach(socket);
  socket.data.code = room.code;
  socket.data.clientId = clientId;
  room.sockets.set(socket.id, clientId);
  socket.join(room.code);
}

function detach(socket) {
  const room = rooms.get(socket.data.code);
  if (room) {
    room.sockets.delete(socket.id);
    socket.leave(room.code);
    broadcast(room);
  }
  socket.data.code = null;
}

function hostRoom(socket) {
  const room = rooms.get(socket.data.code);
  if (!room || room.hostId !== socket.data.clientId) return null;
  return room;
}

// returns {room, me} only when the caller is a living player in a running game
function playerCtx(socket) {
  const room = rooms.get(socket.data.code);
  if (!room || room.status !== "playing" || room.winner) return null;
  const me = room.players.get(socket.data.clientId);
  if (!alive(me)) return null;
  return { room, me };
}

function sanitizeRoles(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 30).map((r, i) => ({
    id: clean(r?.id, 40) || "r" + i,
    name: clean(r?.name, 24) || "شخصية",
    team: TEAMS.has(r?.team) ? r.team : "town",
    ability: ABILITIES.has(r?.ability) ? r.ability : "none",
    count: Math.max(0, Math.min(30, Math.floor(Number(r?.count) || 0))),
    desc: clean(r?.desc, 160),
  }));
}

io.on("connection", (socket) => {
  const reply = (cb, data) => typeof cb === "function" && cb(data);
  const NO = { error: "مش مسموح هلأ" };

  socket.on("create", ({ clientId } = {}, cb) => {
    if (!validId(clientId)) return reply(cb, { error: "معرّف غير صالح، حدّث الصفحة." });
    const code = newCode();
    const room = {
      code, hostId: clientId, status: "lobby", round: 0,
      roles: DEFAULT_ROLES.map((r) => ({ ...r })),
      players: new Map(), sockets: new Map(), touched: Date.now(),
    };
    resetGame(room);
    rooms.set(code, room);
    attach(socket, room, clientId);
    reply(cb, { ok: true, code });
    broadcast(room);
  });

  socket.on("join", ({ clientId, code, name } = {}, cb) => {
    if (!validId(clientId)) return reply(cb, { error: "معرّف غير صالح، حدّث الصفحة." });
    code = clean(code, 5).toUpperCase();
    name = clean(name, 24);
    const room = rooms.get(code);
    if (!room) return reply(cb, { error: "ما في غرفة بهذا الكود. تأكد منه." });
    if (room.hostId !== clientId) {
      if (!name) return reply(cb, { error: "اكتب اسمك أول." });
      const existing = room.players.get(clientId);
      if (existing) existing.name = name;
      else {
        if (room.players.size >= 40) return reply(cb, { error: "الغرفة مليانة." });
        room.players.set(clientId, { id: clientId, name, out: false, role: null, joinedAt: Date.now() });
      }
    }
    attach(socket, room, clientId);
    reply(cb, { ok: true, code });
    broadcast(room);
  });

  socket.on("resume", ({ clientId, code } = {}, cb) => {
    const room = rooms.get(clean(code, 5).toUpperCase());
    if (!validId(clientId) || !room || (room.hostId !== clientId && !room.players.has(clientId)))
      return reply(cb, { error: "gone" });
    attach(socket, room, clientId);
    reply(cb, { ok: true, code: room.code });
    broadcast(room);
  });

  socket.on("leave", (_d, cb) => {
    const room = rooms.get(socket.data.code);
    if (room && room.hostId !== socket.data.clientId) {
      room.players.delete(socket.data.clientId);
      room.votes.delete(socket.data.clientId);
    }
    detach(socket);
    reply(cb, { ok: true });
  });

  socket.on("home", (_d, cb) => { detach(socket); reply(cb, { ok: true }); });

  // ----- host actions -----
  socket.on("setRoles", ({ roles } = {}, cb) => {
    const room = hostRoom(socket);
    const list = sanitizeRoles(roles);
    if (!room || !list) return reply(cb, NO);
    room.roles = list;
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on("kick", ({ id } = {}, cb) => {
    const room = hostRoom(socket);
    if (!room) return reply(cb, NO);
    room.players.delete(id);
    room.votes.delete(id);
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on("setOut", ({ id, out } = {}, cb) => {
    const room = hostRoom(socket);
    const p = room && room.players.get(id);
    if (!p) return reply(cb, { error: "مش موجود" });
    if (p.out === !!out) return reply(cb, { ok: true });
    // بعد ما تنتهي اللعبة، الحكم بيقدر بس يرجّع حدا انشطب بالغلط
    if (room.winner && out) return reply(cb, { error: "اللعبة انتهت." });
    p.out = !!out;
    if (room.status === "playing" && p.role) {
      if (p.out) {
        room.announceSeq += 1;
        room.announce = { seq: room.announceSeq, id: p.id, name: p.name, team: p.role.team };
      } else if (room.announce?.id === p.id) {
        room.announce = null; // الحكم رجّعه، يعني كان غلط
      }
      // طرد بالليل يعني النهار جاي؛ طرد بالنهار أو التصويت يعني الليل جاي
      room.winner = computeWinner(room, room.phase !== "night");
    }
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on("deal", (_d, cb) => {
    const room = hostRoom(socket);
    if (!room) return reply(cb, NO);
    const players = [...room.players.values()];
    const pool = [];
    for (const r of room.roles) for (let i = 0; i < r.count; i++) pool.push(r);
    if (players.length < 3) return reply(cb, { error: "لازم يكون في 3 لاعبين على الأقل." });
    if (pool.length > players.length) return reply(cb, { error: "الشخصيات أكثر من اللاعبين." });
    if (!pool.some((r) => r.team === "mafia")) return reply(cb, { error: "لازم يكون في مافيا واحد على الأقل." });
    while (pool.length < players.length) pool.push(CITIZEN);
    shuffle(pool);
    players.forEach((p, i) => {
      const r = pool[i];
      p.role = { name: r.name, team: r.team, ability: r.ability || "none", desc: r.desc };
      p.out = false;
    });
    room.status = "playing";
    room.round += 1;
    resetGame(room);
    room.night = 1;
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on("setPhase", ({ phase } = {}, cb) => {
    const room = hostRoom(socket);
    if (!room || room.status !== "playing" || room.winner || !PHASES.has(phase)) return reply(cb, NO);
    if (phase === room.phase) return reply(cb, { ok: true });
    if (phase === "night") { room.night += 1; resetNight(room); }
    if (phase === "vote") room.votes = new Map();
    room.phase = phase;
    room.announce = null;
    // الليل بلّش: إذا المافيا ناقصهم واحد وما في حدا يحمي، اللعبة انحسمت
    room.winner = computeWinner(room, phase === "night");
    broadcast(room);
    reply(cb, { ok: true });
  });

  // الحكم بيرد على المفتش/المحقق
  socket.on("answer", ({ playerId, answer } = {}, cb) => {
    const room = hostRoom(socket);
    const a = room && room.actions.get(playerId);
    if (!a || !["mafia", "town"].includes(answer)) return reply(cb, NO);
    a.reply = answer;
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on("endRound", (_d, cb) => {
    const room = hostRoom(socket);
    if (!room) return reply(cb, NO);
    for (const p of room.players.values()) { p.role = null; p.out = false; }
    room.status = "lobby";
    resetGame(room);
    broadcast(room);
    reply(cb, { ok: true });
  });

  // ----- player actions -----
  const validTarget = (room, id) => alive(room.players.get(id));

  socket.on("nightAction", ({ targetId } = {}, cb) => {
    const ctx = playerCtx(socket);
    if (!ctx || ctx.room.phase !== "night") return reply(cb, { error: "الاختيار بيكون بالليل بس." });
    const { room, me } = ctx;
    if (me.role.team === "mafia" || me.role.ability === "none") return reply(cb, NO);
    if (!validTarget(room, targetId)) return reply(cb, { error: "اختار لاعب لسا باللعبة." });
    room.actions.set(me.id, { targetId, reply: null });
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on("mafiaVote", ({ targetId } = {}, cb) => {
    const ctx = playerCtx(socket);
    if (!ctx || ctx.room.phase !== "night" || ctx.me.role.team !== "mafia") return reply(cb, NO);
    if (!validTarget(ctx.room, targetId)) return reply(cb, { error: "اختار لاعب لسا باللعبة." });
    ctx.room.mafia.votes.set(ctx.me.id, targetId);
    broadcast(ctx.room);
    reply(cb, { ok: true });
  });

  socket.on("mafiaChat", ({ text } = {}, cb) => {
    const ctx = playerCtx(socket);
    if (!ctx || ctx.me.role.team !== "mafia") return reply(cb, NO);
    text = clean(text, 200);
    if (!text) return reply(cb, { ok: true });
    const chat = ctx.room.mafia.chat;
    chat.push({ from: ctx.me.id, text });
    if (chat.length > 40) chat.splice(0, chat.length - 40);
    broadcast(ctx.room);
    reply(cb, { ok: true });
  });

  socket.on("mafiaSend", ({ targetId } = {}, cb) => {
    const ctx = playerCtx(socket);
    if (!ctx || ctx.room.phase !== "night" || ctx.me.role.team !== "mafia") return reply(cb, NO);
    if (!validTarget(ctx.room, targetId)) return reply(cb, { error: "اختار لاعب لسا باللعبة." });
    ctx.room.mafia.final = { by: ctx.me.id, targetId };
    broadcast(ctx.room);
    reply(cb, { ok: true });
  });

  socket.on("dayVote", ({ targetId } = {}, cb) => {
    const ctx = playerCtx(socket);
    if (!ctx) return reply(cb, { error: rooms.get(socket.data.code)?.winner ? "اللعبة انتهت." : "انطردت، ما بتقدر تصوّت." });
    if (ctx.room.phase !== "vote") return reply(cb, { error: "التصويت مش مفتوح هلأ." });
    const { room, me } = ctx;
    if (!targetId) room.votes.delete(me.id);
    else {
      if (targetId === me.id) return reply(cb, { error: "ما بتقدر تصوّت على حالك." });
      if (!validTarget(room, targetId)) return reply(cb, { error: "اختار لاعب لسا باللعبة." });
      room.votes.set(me.id, targetId);
    }
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.code);
    if (room) { room.sockets.delete(socket.id); broadcast(room); }
  });
});

// rooms nobody touched for 12 hours are removed
setInterval(() => {
  const cutoff = Date.now() - 12 * 3600 * 1000;
  for (const [code, room] of rooms) if (room.touched < cutoff && room.sockets.size === 0) rooms.delete(code);
}, 30 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Mafia server on :" + PORT));
