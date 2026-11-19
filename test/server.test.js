// فحوصات السيرفر: بتشغّل السيرفر الحقيقي وبتلعب عليه بلاعبين وهميين.
// تشغيل: npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { io } = require("socket.io-client");

const PORT = 3900 + Math.floor(Math.random() * 90);
const URL = `http://localhost:${PORT}`;
let srv;
const sockets = [];
let seq = 0;

before(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT }, stdio: "pipe" });
  await new Promise((res, rej) => {
    srv.stdout.on("data", (d) => String(d).includes("Mafia server") && res());
    srv.on("exit", (c) => rej(new Error("server exited " + c)));
  });
});
after(() => { sockets.forEach((s) => s.disconnect()); srv.kill(); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** a connected client with a stable id; .last holds the latest state it received */
async function client(id) {
  const s = io(URL, { transports: ["websocket"], forceNew: true });
  s.cid = id || `c${Date.now().toString(36)}${(seq++).toString(36)}xxxx`;
  s.last = null;
  s.on("state", (st) => { s.last = st; });
  sockets.push(s);
  await new Promise((r) => s.on("connect", r));
  return s;
}
const call = (s, ev, d = {}) => new Promise((r) => s.emit(ev, { clientId: s.cid, ...d }, r));
// wait until every listed client has received a state that satisfies fn
async function settle(list = [], fn = () => true) {
  for (let i = 0; i < 60; i++) {
    if (list.every((s) => s.last && fn(s.last, s))) return;
    await wait(15);
  }
  await wait(30);
}

async function room(n, roles) {
  const host = await client();
  const { code } = await call(host, "create");
  const ps = [];
  for (let i = 0; i < n; i++) {
    const p = await client();
    const r = await call(p, "join", { code, name: "لاعب" + (i + 1) });
    assert.ok(r.ok, "join failed: " + JSON.stringify(r));
    ps.push(p);
  }
  if (roles) assert.ok((await call(host, "setRoles", { roles })).ok);
  await settle([host], (st) => st.players.length === n);
  return { host, ps, code };
}
async function dealt(n, roles) {
  const g = await room(n, roles);
  const r = await call(g.host, "deal");
  assert.ok(r.ok, JSON.stringify(r));
  await settle([g.host, ...g.ps], (st) => st.status === "playing");
  g.role = (p) => p.last.myRole;
  g.mafia = g.ps.filter((p) => g.role(p).team === "mafia");
  g.town = g.ps.filter((p) => g.role(p).team !== "mafia");
  g.by = (name) => g.ps.find((p) => g.role(p).name === name);
  g.all = [g.host, ...g.ps];
  return g;
}
const R = (name, team, count, ability = "none") => ({ name, team, count, ability });
const ONLY_MAFIA = (m) => [R("مافيا", "mafia", m)];

// ---------------------------------------------------------------- rooms & joining
test("الغرفة: إنشاء ودخول وأخطاء الإدخال", async () => {
  const host = await client();
  assert.match((await call(host, "create", { clientId: "bad id!" })).error, /معرّف/);
  const { code, ok } = await call(host, "create");
  assert.ok(ok);
  assert.match(code, /^[A-Z2-9]{5}$/);

  const p = await client();
  assert.match((await call(p, "join", { code: "ZZZZZ", name: "س" })).error, /ما في غرفة/);
  assert.match((await call(p, "join", { code, name: "   " })).error, /اسمك/);
  assert.ok((await call(p, "join", { code: code.toLowerCase(), name: "سامي" })).ok, "lower-case code works");

  const q = await client();
  assert.match((await call(q, "join", { code, name: "سامي" })).error, /نفس الاسم/);
  assert.ok((await call(q, "join", { code, name: "ليلى" })).ok);

  // same player rejoining just renames, no duplicate seat
  assert.ok((await call(p, "join", { code, name: "سامي ٢" })).ok);
  // host joining own room is not a player
  assert.ok((await call(host, "join", { code })).ok);
  await settle([host], (st) => st.players.length === 2 && st.players.some((x) => x.name === "سامي ٢"));
  assert.deepEqual(host.last.players.map((x) => x.name).sort(), ["سامي ٢", "ليلى"].sort());
  assert.equal(host.last.isHost, true);
  assert.equal(p.last.isHost, false);
});

test("الغرفة: الاسم الطويل بينقص و40 لاعب حد أقصى", async () => {
  const host = await client();
  const { code } = await call(host, "create");
  const p = await client();
  await call(p, "join", { code, name: "ا".repeat(60) });
  await settle([host], (st) => st.players.length === 1);
  assert.equal(host.last.players[0].name.length, 24);
  for (let i = 1; i < 40; i++) { const c = await client(); assert.ok((await call(c, "join", { code, name: "x" + i })).ok); }
  const extra = await client();
  assert.match((await call(extra, "join", { code, name: "زيادة" })).error, /مليانة/);
});

test("الغرف معزولة عن بعض", async () => {
  const a = await room(3), b = await room(3);
  await settle([a.host, b.host]);
  assert.equal(a.host.last.players.length, 3);
  assert.ok(!a.host.last.players.some((p) => b.ps.map((x) => x.cid).includes(p.id)));
  assert.match((await call(b.host, "kick", { id: a.ps[0].cid })).error || "ok", /ok/); // kick in wrong room does nothing
  await settle([a.host]);
  assert.equal(a.host.last.players.length, 3);
});

test("الرجوع بعد تحديث الصفحة بيرجّع نفس الشخصية", async () => {
  const g = await dealt(4, ONLY_MAFIA(1));
  const p = g.ps[2], myRole = g.role(p).name;
  p.disconnect();
  await settle([g.host], (st) => st.players.some((x) => x.id === p.cid && !x.online));
  assert.equal(g.host.last.players.find((x) => x.id === p.cid).online, false);
  const again = await client(p.cid);
  assert.ok((await call(again, "resume", { code: g.code })).ok);
  await settle([again], (st) => st.myRole);
  assert.equal(again.last.myRole.name, myRole);
  await settle([g.host], (st) => st.players.find((x) => x.id === p.cid).online);
  // a stranger can't resume into the room
  const stranger = await client();
  assert.equal((await call(stranger, "resume", { code: g.code })).error, "gone");
});

test("الحكم بيطلّع لاعب، واللاعب بيغادر", async () => {
  const g = await room(4);
  assert.ok((await call(g.host, "kick", { id: g.ps[0].cid })).ok);
  assert.equal((await call(g.ps[1], "kick", { id: g.ps[2].cid })).error, "مش مسموح هلأ");
  await call(g.ps[3], "leave");
  await settle([g.host], (st) => st.players.length === 2);
  assert.deepEqual(g.host.last.players.map((p) => p.id).sort(), [g.ps[1].cid, g.ps[2].cid].sort());
  await settle([g.ps[0]], (st) => !st.inRoom);
  assert.equal(g.ps[0].last.inRoom, false);
  assert.equal((await call(g.ps[3], "resume", { code: g.code })).error, "gone");
});

// ---------------------------------------------------------------- roles & dealing
test("الشخصيات: تنظيف الإدخال والحكم بس بيعدّل", async () => {
  const g = await room(3);
  assert.equal((await call(g.ps[0], "setRoles", { roles: [] })).error, "مش مسموح هلأ");
  assert.equal((await call(g.host, "setRoles", { roles: "x" })).error, "مش مسموح هلأ");
  await call(g.host, "setRoles", { roles: [{ name: "<b>x</b>".repeat(10), team: "hacker", ability: "fly", count: 999, desc: "d".repeat(500) }, { count: -4 }] });
  await settle([g.host], (st) => st.roles[0].team === "town");
  const [a, b] = g.host.last.roles;
  assert.equal(a.name.length, 24);
  assert.equal(a.team, "town");
  assert.equal(a.ability, "none");
  assert.equal(a.count, 30);
  assert.equal(a.desc.length, 160);
  assert.equal(b.count, 0);
  assert.equal(g.ps[0].last.roles, null, "players don't get the role setup");
});

test("التوزيع: الشروط", async () => {
  const g = await room(2);
  assert.match((await call(g.host, "deal")).error, /3 لاعبين/);
  const g2 = await room(3, [R("مافيا", "mafia", 2), R("دكتور", "town", 2)]);
  assert.match((await call(g2.host, "deal")).error, /أكثر من اللاعبين/);
  const g3 = await room(3, [R("دكتور", "town", 1)]);
  assert.match((await call(g3.host, "deal")).error, /مافيا واحد/);
  assert.equal((await call(g3.ps[0], "deal")).error, "مش مسموح هلأ");
});

test("التوزيع: كل لاعب بيوصله دوره بس، والعدد مضبوط", async () => {
  const g = await dealt(9);
  const names = g.ps.map((p) => g.role(p).name);
  const count = (n) => names.filter((x) => x === n).length;
  assert.equal(count("مافيا"), 2);
  assert.equal(count("مفتش"), 1);
  assert.equal(count("محقق"), 1);
  assert.equal(count("دكتور"), 1);
  assert.equal(count("مواطن"), 4);
  for (const p of g.ps) {
    assert.ok(!p.last.players.some((x) => x.role || x.team), "player must not see any role");
    assert.equal(p.last.report, undefined);
    assert.equal(p.last.roles, null);
    if (g.role(p).team === "mafia") {
      const mate = g.mafia.find((m) => m !== p);
      assert.deepEqual(g.role(p).mates, [mate.last.players.find((x) => x.id === mate.cid).name]);
      assert.ok(p.last.mafia);
    } else {
      assert.deepEqual(g.role(p).mates, []);
      assert.equal(p.last.mafia, undefined, "town must not see mafia room");
    }
  }
  assert.ok(g.host.last.players.every((x) => x.role && x.team), "host sees everyone");
  assert.equal(g.host.last.phase, "night");
  assert.equal(g.host.last.night, 1);
});

test("التوزيع عشوائي فعلاً", async () => {
  const g = await room(6, ONLY_MAFIA(1));
  const hits = new Map(g.ps.map((p) => [p.cid, 0]));
  const N = 300;
  for (let i = 0; i < N; i++) {
    await call(g.host, "deal");
    await settle(g.ps, (st) => st.round === i + 1 && st.myRole);
    hits.set(g.ps.find((p) => p.last.myRole.team === "mafia").cid, hits.get(g.ps.find((p) => p.last.myRole.team === "mafia").cid) + 1);
  }
  // each of 6 players expects 50; anything between 25 and 80 is fine, outside means a broken shuffle
  for (const v of hits.values()) assert.ok(v > 25 && v < 80, `mafia counts look skewed: ${[...hits.values()]}`);
});

test("لاعب دخل بعد التوزيع ما بياخد شخصية وما بيخرّب الحسبة", async () => {
  const g = await dealt(4, ONLY_MAFIA(1));
  const late = await client();
  assert.ok((await call(late, "join", { code: g.code, name: "متأخر" })).ok);
  await settle([late], (st) => st.status === "playing");
  assert.equal(late.last.myRole, null);
  assert.match((await call(late, "nightAction", { targetId: g.ps[0].cid })).error, /بالليل بس|مسموح/);
  await call(g.host, "setPhase", { phase: "vote" });
  assert.ok((await call(late, "dayVote", { targetId: g.ps[0].cid })).error);
  assert.equal(g.host.last.winner, null);
});

// ---------------------------------------------------------------- phases
test("المراحل: الحكم بس، والليل بيمسح اختيارات الليلة الماضية", async () => {
  const g = await dealt(6);
  assert.equal((await call(g.ps[0], "setPhase", { phase: "day" })).error, "مش مسموح هلأ");
  assert.equal((await call(g.host, "setPhase", { phase: "lunch" })).error, "مش مسموح هلأ");
  const doc = g.by("دكتور");
  await call(doc, "nightAction", { targetId: doc.cid });
  await call(g.mafia[0], "mafiaVote", { targetId: g.town[0].cid });
  await call(g.mafia[0], "mafiaChat", { text: "مرحبا" });
  await call(g.mafia[0], "mafiaSend", { targetId: g.town[0].cid });
  await call(g.host, "setPhase", { phase: "day" });
  await settle([g.host], (st) => st.phase === "day");
  assert.equal(g.host.last.report.actions.find((a) => a.actorId === doc.cid).targetId, doc.cid, "action survives into the day");
  await call(g.host, "setPhase", { phase: "night" });
  await settle([g.host, g.mafia[1]], (st) => st.night === 2);
  assert.ok(g.host.last.report.actions.every((a) => !a.targetId));
  assert.equal(g.host.last.report.mafia.final, null);
  assert.equal(g.mafia[1].last.mafia.votes.length, 0);
  assert.equal(g.mafia[1].last.mafia.chat.length, 1, "chat history is kept");
  // same phase twice doesn't skip a night
  await call(g.host, "setPhase", { phase: "night" });
  await settle([g.host]);
  assert.equal(g.host.last.night, 2);
});

// ---------------------------------------------------------------- night actions
test("الليل: الدكتور والمحقق بيختاروا والحكم بيرد", async () => {
  const g = await dealt(6);
  const doc = g.by("دكتور"), det = g.by("محقق"), cit = g.by("مواطن");
  assert.ok((await call(doc, "nightAction", { targetId: doc.cid })).ok, "doctor may protect himself");
  assert.match((await call(det, "nightAction", { targetId: det.cid })).error, /تفحص حالك/);
  assert.equal((await call(cit, "nightAction", { targetId: doc.cid })).error, "مش مسموح هلأ");
  assert.equal((await call(g.mafia[0], "nightAction", { targetId: doc.cid })).error, "مش مسموح هلأ");
  assert.match((await call(det, "nightAction", { targetId: "nobody123" })).error, /لسا باللعبة/);
  assert.ok((await call(det, "nightAction", { targetId: doc.cid })).ok);
  assert.ok((await call(det, "nightAction", { targetId: g.mafia[0].cid })).ok, "can change the pick");
  await settle([g.host, det], (st) => (st.report ? st.report.actions.find((a) => a.actorId === det.cid)?.targetId === g.mafia[0].cid : st.myAction?.targetId === g.mafia[0].cid));
  const a = g.host.last.report.actions.find((x) => x.actorId === det.cid);
  assert.equal(a.targetTeam, "mafia");
  assert.equal(a.targetRole, "مافيا");
  assert.equal(det.last.myAction.reply, null);
  // answering
  assert.equal((await call(det, "answer", { playerId: det.cid, answer: "town" })).error, "مش مسموح هلأ");
  assert.equal((await call(g.host, "answer", { playerId: det.cid, answer: "maybe" })).error, "مش مسموح هلأ");
  assert.equal((await call(g.host, "answer", { playerId: cit.cid, answer: "town" })).error, "مش مسموح هلأ");
  assert.ok((await call(g.host, "answer", { playerId: det.cid, answer: "mafia" })).ok);
  await settle([det], (st) => st.myAction?.reply === "mafia");
  assert.equal(det.last.myAction.reply, "mafia");
  assert.equal(doc.last.myAction.reply, null, "the doctor doesn't see the detective's answer");
  // nobody else learns the detective's pick
  for (const p of g.ps.filter((x) => x !== det)) assert.notEqual(p.last.myAction?.targetId === g.mafia[0].cid && p !== doc, true);
  // night is over: no more picks
  await call(g.host, "setPhase", { phase: "day" });
  assert.match((await call(doc, "nightAction", { targetId: det.cid })).error, /بالليل بس/);
});

test("الليل: غرفة المافيا", async () => {
  const g = await dealt(7);
  const [m1, m2] = g.mafia, t = g.town[0];
  assert.equal((await call(t, "mafiaVote", { targetId: t.cid })).error, "مش مسموح هلأ");
  assert.equal((await call(t, "mafiaChat", { text: "هاي" })).error, "مش مسموح هلأ");
  assert.equal((await call(t, "mafiaSend", { targetId: t.cid })).error, "مش مسموح هلأ");
  assert.ok((await call(m1, "mafiaVote", { targetId: g.town[0].cid })).ok);
  assert.ok((await call(m2, "mafiaVote", { targetId: g.town[1].cid })).ok);
  assert.ok((await call(m1, "mafiaChat", { text: "  " })).ok, "empty message is ignored");
  assert.ok((await call(m2, "mafiaChat", { text: "<img src=x onerror=alert(1)>" + "ا".repeat(300) })).ok);
  assert.ok((await call(m2, "mafiaSend", { targetId: g.town[1].cid })).ok);
  await settle([m1, g.host], (st) => (st.mafia || st.report?.mafia)?.final);
  const mv = m1.last.mafia;
  assert.equal(mv.votes.length, 2);
  assert.equal(mv.chat.length, 1);
  assert.equal(mv.chat[0].text.length, 200);
  assert.equal(mv.final.targetId, g.town[1].cid);
  assert.equal(g.host.last.report.mafia.final.targetId, g.town[1].cid);
  for (const p of g.town) assert.equal(p.last.mafia, undefined);
  // chat keeps only the last 40
  for (let i = 0; i < 45; i++) await call(m1, "mafiaChat", { text: "m" + i });
  await settle([m2], (st) => st.mafia.chat.length === 40 && st.mafia.chat.at(-1).text === "m44");
  assert.equal(m2.last.mafia.chat[0].text, "m5");
  // voting/sending only at night, chat any time
  await call(g.host, "setPhase", { phase: "day" });
  assert.equal((await call(m1, "mafiaVote", { targetId: g.town[0].cid })).error, "مش مسموح هلأ");
  assert.equal((await call(m1, "mafiaSend", { targetId: g.town[0].cid })).error, "مش مسموح هلأ");
  assert.ok((await call(m1, "mafiaChat", { text: "بالنهار" })).ok);
});

// ---------------------------------------------------------------- day vote
test("التصويت: العداد بيطلع وبينزل، والتغيير والإلغاء", async () => {
  const g = await dealt(6);
  const [a, b, c, d] = g.ps;
  assert.match((await call(a, "dayVote", { targetId: b.cid })).error, /مش مفتوح/);
  await call(g.host, "setPhase", { phase: "vote" });
  assert.match((await call(a, "dayVote", { targetId: a.cid })).error, /على حالك/);
  const count = (st, id) => (st.tally.find((t) => t.targetId === id) || { count: 0 }).count;
  await call(a, "dayVote", { targetId: b.cid });
  await call(c, "dayVote", { targetId: b.cid });
  await call(d, "dayVote", { targetId: b.cid });
  await settle(g.all, (st) => count(st, b.cid) === 3);
  for (const s of g.all) assert.equal(count(s.last, b.cid), 3, "everyone sees the same counter");
  await call(c, "dayVote", { targetId: null }); // remove
  await call(d, "dayVote", { targetId: a.cid }); // change
  await settle(g.all, (st) => count(st, b.cid) === 1 && count(st, a.cid) === 1);
  for (const s of g.all) { assert.equal(count(s.last, b.cid), 1); assert.equal(count(s.last, a.cid), 1); }
  assert.equal(d.last.myVote, a.cid);
  assert.equal(c.last.myVote, null);
  assert.deepEqual(g.host.last.tally.find((t) => t.targetId === b.cid).voters, [a.last.players.find((x) => x.id === a.cid).name]);
  // reopening the vote starts from zero
  await call(g.host, "setPhase", { phase: "day" });
  await call(g.host, "setPhase", { phase: "vote" });
  await settle([g.host], (st) => st.phase === "vote" && st.tally.length === 0);
  assert.deepEqual(g.host.last.tally, []);
});

test("التصويت: 7 لاعبين بيصوّتوا بنفس اللحظة", async () => {
  const g = await dealt(7);
  await call(g.host, "setPhase", { phase: "vote" });
  const target = g.ps[0];
  await Promise.all(g.ps.slice(1).map((p) => call(p, "dayVote", { targetId: target.cid })));
  await settle(g.all, (st) => st.tally[0]?.count === 6);
  for (const s of g.all) assert.equal(s.last.tally[0].count, 6);
});

// ---------------------------------------------------------------- elimination
test("الطرد: الكل بيعرف الفريق بس مش الشخصية", async () => {
  const g = await dealt(7);
  const doc = g.by("دكتور");
  await call(g.host, "setPhase", { phase: "vote" });
  await call(g.ps.find((p) => p !== doc), "dayVote", { targetId: doc.cid });
  await call(doc, "dayVote", { targetId: g.ps.find((p) => p !== doc).cid });
  assert.ok((await call(g.host, "setOut", { id: doc.cid, out: true })).ok);
  await settle(g.all, (st) => st.announce?.id === doc.cid);
  for (const p of g.ps) {
    const st = p.last;
    assert.equal(st.announce.team, "town");
    assert.equal(st.announce.name, doc.last.players.find((x) => x.id === doc.cid).name);
    assert.ok(!JSON.stringify(st.announce).includes("دكتور"), "announcement must not name the role");
    const seen = st.players.find((x) => x.id === doc.cid);
    assert.equal(seen.out, true);
    assert.equal(seen.revealed, "town");
    assert.equal(seen.role, undefined, "role stays hidden");
    assert.equal(st.tally.find((t) => t.targetId === doc.cid), undefined, "votes on a struck player don't count");
    assert.ok(!st.tally.some((t) => t.voters.includes(seen.name)), "a struck player's vote doesn't count");
  }
  assert.match((await call(doc, "dayVote", { targetId: g.ps[0].cid })).error, /انطردت/);
  // stays struck through later phases
  await call(g.host, "setPhase", { phase: "night" });
  await call(g.host, "setPhase", { phase: "day" });
  await settle([g.ps[0]], (st) => st.phase === "day");
  assert.equal(g.ps[0].last.players.find((x) => x.id === doc.cid).out, true);
  assert.equal(g.ps[0].last.announce, null, "the banner clears when the phase changes");
  // undo
  await call(g.host, "setOut", { id: doc.cid, out: false });
  await settle([g.ps[0]], (st) => !st.players.find((x) => x.id === doc.cid).out);
  assert.equal(g.ps[0].last.players.find((x) => x.id === doc.cid).revealed, undefined);
});

test("الطرد: مافيا منطرد بيطلع مافيا للكل", async () => {
  const g = await dealt(7);
  await call(g.host, "setOut", { id: g.mafia[0].cid, out: true });
  await settle(g.ps, (st) => st.announce);
  for (const p of g.ps) assert.equal(p.last.announce.team, "mafia");
  assert.equal(g.mafia[0].last.mafia, undefined, "a dead mafia leaves the mafia room");
  assert.equal((await call(g.mafia[0], "mafiaChat", { text: "x" })).error, "مش مسموح هلأ");
});

// ---------------------------------------------------------------- end of game
async function strike(g, p, phase) {
  if (phase && g.host.last.phase !== phase) await call(g.host, "setPhase", { phase });
  const r = await call(g.host, "setOut", { id: p.cid, out: true });
  await settle([g.host], (st) => st.players.find((x) => x.id === p.cid).out);
  return r;
}
const winner = (g) => g.host.last.winner;

test("النهاية: المدينة بتربح لما ينطرد كل المافيا", async () => {
  const g = await dealt(7);
  await strike(g, g.mafia[0], "vote");
  assert.equal(winner(g), null);
  await strike(g, g.mafia[1], "vote");
  assert.equal(winner(g).team, "town");
});

test("النهاية: المافيا بتربح لما يصيروا قد الباقيين", async () => {
  // 2 mafia + 3 town; a night kill makes it 2 vs 2
  const g = await dealt(5, [R("مافيا", "mafia", 2), R("دكتور", "town", 1, "pick")]);
  await strike(g, g.town.find((p) => g.role(p).name === "مواطن"), "night");
  assert.equal(winner(g).team, "mafia");
  assert.match(winner(g).reason, /2 مافيا مقابل 2/);
});

test("النهاية: 1 مافيا و2 صالحين بعد التصويت وما في دكتور = المافيا ربحت", async () => {
  const g = await dealt(4, ONLY_MAFIA(1)); // 1 mafia + 3 citizens
  await strike(g, g.town[0], "vote");
  assert.equal(winner(g).team, "mafia");
  assert.match(winner(g).reason, /بالليل الجاي/);
});

test("النهاية: 1 مافيا و2 صالحين بعد الليل = بنكمّل (التصويت جاي)", async () => {
  const g = await dealt(4, ONLY_MAFIA(1));
  await strike(g, g.town[0], "night");
  assert.equal(winner(g), null);
  // the town fails to vote anyone out; the host starts the next night -> now it's decided
  await call(g.host, "setPhase", { phase: "vote" });
  await call(g.host, "setPhase", { phase: "night" });
  await settle([g.host], (st) => st.winner);
  assert.equal(winner(g).team, "mafia");
});

test("النهاية: 1 مافيا و2 صالحين والدكتور عايش = بنكمّل", async () => {
  const g = await dealt(4, [R("مافيا", "mafia", 1), R("دكتور", "town", 1, "pick")]);
  await strike(g, g.town.find((p) => g.role(p).name === "مواطن"), "vote");
  assert.equal(winner(g), null, "the doctor can still save someone");
  await strike(g, g.by("دكتور"), "night"); // now 1 vs 1
  assert.equal(winner(g).team, "mafia");
});

test("النهاية: 2 مافيا و3 صالحين بعد التصويت وما في دكتور = المافيا ربحت", async () => {
  const g = await dealt(6, [R("مافيا", "mafia", 2), R("مفتش", "town", 1, "check")]);
  await strike(g, g.town[0], "vote"); // 2 vs 3, no protector
  assert.equal(winner(g).team, "mafia");
});

test("النهاية: لعبة كبيرة بتكمّل لحد الحسم بس", async () => {
  const g = await dealt(10); // 2 mafia, 8 others, doctor alive
  const order = g.town.filter((p) => g.role(p).name !== "دكتور");
  await strike(g, order[0], "night"); assert.equal(winner(g), null); // 2 v 7
  await strike(g, order[1], "vote"); assert.equal(winner(g), null);  // 2 v 6
  await strike(g, order[2], "night"); assert.equal(winner(g), null); // 2 v 5
  await strike(g, order[3], "vote"); assert.equal(winner(g), null);  // 2 v 4
  await strike(g, g.mafia[0], "vote"); assert.equal(winner(g), null); // 1 v 4
  await strike(g, order[4], "night"); assert.equal(winner(g), null); // 1 v 3 (doctor alive)
  await strike(g, g.mafia[1], "vote"); assert.equal(winner(g).team, "town");
});

test("النهاية: لاعب عايش غادر وحسم اللعبة", async () => {
  const g = await dealt(5, [R("مافيا", "mafia", 2), R("دكتور", "town", 1, "pick")]);
  await call(g.town[0], "leave"); // 2 v 2
  await settle([g.host], (st) => st.winner);
  assert.equal(winner(g).team, "mafia");
});

test("النهاية: بعد ما تخلص كل اشي مسكّر، والكل بيشوف الشخصيات", async () => {
  const g = await dealt(7);
  await strike(g, g.mafia[0], "vote");
  await strike(g, g.mafia[1], "vote");
  await settle(g.all, (st) => st.winner);
  for (const p of g.ps) {
    assert.equal(p.last.winner.team, "town");
    assert.ok(p.last.players.every((x) => x.role && x.team), "everyone sees every role at the end");
    assert.equal(p.last.tally, null);
  }
  const alive = g.town[0];
  assert.match((await call(alive, "dayVote", { targetId: g.town[1].cid })).error, /انتهت/);
  assert.equal((await call(g.host, "setPhase", { phase: "night" })).error, "مش مسموح هلأ");
  assert.match((await call(g.host, "setOut", { id: g.town[1].cid, out: true })).error, /انتهت/);
  // undoing a mistaken strike reopens the game
  await call(g.host, "setOut", { id: g.mafia[1].cid, out: false });
  await settle([g.host], (st) => !st.winner);
  assert.equal(winner(g), null);
  // re-end, then play again
  await strike(g, g.mafia[1]);
  assert.equal(winner(g).team, "town");
  assert.ok((await call(g.host, "deal")).ok);
  await settle(g.all, (st) => st.round === 2 && st.status === "playing");
  for (const p of g.ps) {
    assert.equal(p.last.winner, null);
    assert.equal(p.last.players.every((x) => !x.out), true);
    assert.equal(p.last.announce, null);
    assert.ok(p.last.myRole);
    assert.ok(!p.last.players.some((x) => x.role), "roles hidden again in the new game");
  }
  assert.equal(g.host.last.night, 1);
});

test("إنهاء اللفة بيرجّع الكل لصفحة الانتظار", async () => {
  const g = await dealt(5);
  await strike(g, g.town[0], "vote");
  assert.ok((await call(g.host, "endRound")).ok);
  await settle(g.all, (st) => st.status === "lobby");
  for (const s of g.all) {
    assert.equal(s.last.phase, null);
    assert.equal(s.last.winner, null);
    assert.ok(s.last.players.every((x) => !x.out && !x.revealed));
  }
  for (const p of g.ps) assert.equal(p.last.myRole, null);
  assert.equal((await call(g.ps[0], "endRound")).error, "مش مسموح هلأ");
});

test("طلبات غلط ما بتوقّع السيرفر", async () => {
  const s = await client();
  const evs = ["create", "join", "resume", "leave", "home", "setRoles", "kick", "setOut", "deal", "setPhase", "answer", "endRound", "nightAction", "mafiaVote", "mafiaChat", "mafiaSend", "dayVote"];
  for (const ev of evs) {
    s.emit(ev); // no payload, no callback
    s.emit(ev, null);
    s.emit(ev, 42, () => {});
    await new Promise((r) => s.emit(ev, { clientId: {}, code: [], targetId: { x: 1 }, roles: [null] }, r));
  }
  const ok = await client();
  assert.ok((await call(ok, "create")).ok, "server still alive");
});
