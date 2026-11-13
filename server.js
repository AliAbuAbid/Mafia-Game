// طاولة المافيا — سيرفر الغرف المباشرة
// الشخصيات محفوظة على السيرفر، وكل لاعب بيوصله دوره هو بس. الحكم بيوصله الكل.
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

const DEFAULT_ROLES = [
  { id: "mafia", name: "مافيا", team: "mafia", count: 2, desc: "كل ليلة بتتفقوا مع بعض على لاعب تطلعوه." },
  { id: "inspector", name: "مفتش", team: "town", count: 1, desc: "كل ليلة بتسأل الحكم عن لاعب: مافيا ولا لأ." },
  { id: "detective", name: "محقق", team: "town", count: 1, desc: "بتحقق بشخصية لاعب وبتساعد المدينة تكشف المافيا." },
  { id: "doctor", name: "دكتور", team: "town", count: 1, desc: "كل ليلة بتختار لاعب تحميه من المافيا." },
];
const CITIZEN = { name: "مواطن", team: "town", desc: "ما عندك قدرة خاصة. صوّت صح واكشف المافيا." };
const TEAMS = new Set(["mafia", "town", "neutral"]);
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** rooms: code -> { code, hostId, status, round, roles, players: Map(id -> player), sockets: Map(socketId -> clientId), touched } */
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

function connectedIds(room) {
  return new Set(room.sockets.values());
}

function viewFor(room, clientId) {
  const isHost = room.hostId === clientId;
  const online = connectedIds(room);
  const players = [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    out: p.out,
    online: online.has(p.id),
    ...(isHost && room.status === "playing" && p.role ? { role: p.role.name, team: p.role.team } : {}),
  }));
  const me = room.players.get(clientId);
  let myRole = null;
  if (!isHost && me && room.status === "playing" && me.role) {
    const r = me.role;
    const mates =
      r.team === "mafia"
        ? [...room.players.values()].filter((p) => p.id !== me.id && p.role && p.role.team === "mafia").map((p) => p.name)
        : [];
    myRole = { name: r.name, team: r.team, desc: r.desc || "", mates };
  }
  return {
    code: room.code,
    status: room.status,
    round: room.round,
    isHost,
    hostOnline: online.has(room.hostId),
    inRoom: isHost || !!me,
    meId: clientId,
    roles: isHost ? room.roles : null,
    players,
    myRole,
  };
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

function sanitizeRoles(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 30).map((r, i) => ({
    id: clean(r?.id, 40) || "r" + i,
    name: clean(r?.name, 24) || "شخصية",
    team: TEAMS.has(r?.team) ? r.team : "town",
    count: Math.max(0, Math.min(30, Math.floor(Number(r?.count) || 0))),
    desc: clean(r?.desc, 160),
  }));
}

io.on("connection", (socket) => {
  const reply = (cb, data) => typeof cb === "function" && cb(data);

  socket.on("create", ({ clientId } = {}, cb) => {
    if (!validId(clientId)) return reply(cb, { error: "معرّف غير صالح، حدّث الصفحة." });
    const code = newCode();
    const room = {
      code, hostId: clientId, status: "lobby", round: 0,
      roles: DEFAULT_ROLES.map((r) => ({ ...r })),
      players: new Map(), sockets: new Map(), touched: Date.now(),
    };
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

  // reconnect after refresh: only re-attaches if you are already the host or a player
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
    if (room && room.hostId !== socket.data.clientId) room.players.delete(socket.data.clientId);
    detach(socket);
    reply(cb, { ok: true });
  });

  socket.on("home", (_d, cb) => { detach(socket); reply(cb, { ok: true }); });

  // ----- host actions -----
  socket.on("setRoles", ({ roles } = {}, cb) => {
    const room = hostRoom(socket);
    const clean_ = sanitizeRoles(roles);
    if (!room || !clean_) return reply(cb, { error: "مش مسموح" });
    room.roles = clean_;
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on("kick", ({ id } = {}, cb) => {
    const room = hostRoom(socket);
    if (!room) return reply(cb, { error: "مش مسموح" });
    room.players.delete(id);
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on("setOut", ({ id, out } = {}, cb) => {
    const room = hostRoom(socket);
    const p = room && room.players.get(id);
    if (!p) return reply(cb, { error: "مش موجود" });
    p.out = !!out;
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on("deal", (_d, cb) => {
    const room = hostRoom(socket);
    if (!room) return reply(cb, { error: "مش مسموح" });
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
      p.role = { name: r.name, team: r.team, desc: r.desc };
      p.out = false;
    });
    room.status = "playing";
    room.round += 1;
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on("endRound", (_d, cb) => {
    const room = hostRoom(socket);
    if (!room) return reply(cb, { error: "مش مسموح" });
    for (const p of room.players.values()) { p.role = null; p.out = false; }
    room.status = "lobby";
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
