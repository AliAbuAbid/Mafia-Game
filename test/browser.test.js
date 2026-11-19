// فحص الواجهة بمتصفح حقيقي: حكم و7 لاعبين بيلعبوا لعبة كاملة من الأول للآخر.
// بيحتاج Playwright مع Chromium. تشغيل: node test/browser.test.js
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");
const assert = require("node:assert/strict");

const PORT = 3800 + Math.floor(Math.random() * 90);
const U = `http://localhost:${PORT}`;
const checks = [];
const ok = (cond, msg) => { assert.ok(cond, msg); checks.push(msg); };

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT }, stdio: "pipe" });
  await new Promise((r) => srv.stdout.on("data", (d) => String(d).includes("Mafia server") && r()));
  const b = await chromium.launch();
  const errors = [];
  const pages = [];
  const page = async (w = 390) => {
    const ctx = await b.newContext({ viewport: { width: w, height: 844 } });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    // only our own server's files count; outside fonts may be blocked where the test runs
    p.on("requestfailed", (r) => r.url().startsWith(U) && errors.push("request failed: " + r.url()));
    p.on("response", (r) => r.url().startsWith(U) && r.status() >= 400 && errors.push(r.status() + " " + r.url()));
    pages.push(p);
    return p;
  };
  const noOverflow = async (p, label) => {
    const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(w <= 0, `${label}: ما في سكرول عرضي (${w})`);
  };
  const dismiss = async (p) => { if (await p.isVisible("#overlay")) await p.click("#ovOk"); };
  const settle = (p, ms = 250) => p.waitForTimeout(ms);
  const clickRow = async (p, rows, cell, name) => {
    const h = await p.evaluateHandle(([r, c, n]) => [...document.querySelectorAll(r)].find((li) => li.querySelector(c)?.textContent.trim() === n)?.querySelector("[data-out]"), [rows, cell, name]);
    assert.ok(await h.evaluate((x) => !!x), "ما لقيت زر الشطب لـ " + name);
    await h.asElement().click();
  };

  try {
    // ---------- home & create
    const host = await page();
    await host.goto(U);
    await host.waitForSelector("#vHome:not([hidden])");
    await noOverflow(host, "الصفحة الرئيسية");
    await host.click("#joinBtn");
    ok((await host.textContent("#joinErr")).includes("اسمك"), "بيطلب الاسم قبل الدخول");
    await host.fill("#nameIn", "x"); await host.fill("#codeIn", "AB"); await host.click("#joinBtn");
    ok((await host.textContent("#joinErr")).includes("5 أحرف"), "بيفحص طول الكود");
    await host.fill("#codeIn", "ZZZZZ"); await host.click("#joinBtn"); await settle(host);
    ok((await host.textContent("#joinErr")).includes("ما في غرفة"), "كود غلط بيعطي رسالة واضحة");
    await host.click("#createBtn");
    await host.waitForSelector("#hostLobby:not([hidden])");
    const code = (await host.textContent("#roomCode")).trim();
    ok(/^[A-Z2-9]{5}$/.test(code), "الغرفة انفتحت بكود " + code);
    await host.click("#copyBtn"); await settle(host, 150);
    const copied = await host.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    ok(copied.endsWith("?room=" + code), "زر النسخ بينسخ رابط الغرفة");

    // ---------- players join (one with an HTML name, one duplicate)
    const names = ["سامي", "ليلى", "عمر", "رنا", "خالد", "هبة", '<img src onerror=__x=1>'];
    const ps = [];
    for (const n of names) {
      const p = await page(n === "هبة" ? 360 : 390);
      await p.goto(U + "/?room=" + code);
      ok((await p.inputValue("#codeIn")) === code, `رابط الغرفة بيعبّي الكود (${n.slice(0, 6)})`);
      await p.fill("#nameIn", n); await p.click("#joinBtn");
      await p.waitForSelector("#playerPanel:not([hidden])");
      ps.push(p);
    }
    const dup = await page();
    await dup.goto(U + "/?room=" + code); await dup.fill("#nameIn", "سامي"); await dup.click("#joinBtn"); await settle(dup);
    ok((await dup.textContent("#joinErr")).includes("نفس الاسم"), "ما بيقبل اسم مكرر");
    await dup.close();
    await settle(host);
    ok((await host.$$("#hPlayers li")).length === 7, "الحكم شايف 7 لاعبين");
    ok(!(await ps[0].evaluate(() => window.__x)) && !(await host.evaluate(() => window.__x)), "اسم فيه كود HTML بينعرض كنص وما بيشتغل");
    ok((await host.textContent("#hPlayers")).includes("<img"), "الاسم الغريب ظاهر زي ما انكتب");

    // ---------- custom role with a night ability
    await host.click("summary");
    await host.fill("#rName", "حارس"); await host.selectOption("#rTeam", "town"); await host.selectOption("#rAbility", "pick");
    await host.fill("#rDesc", "بيحرس لاعب كل ليلة"); await host.click("#addRoleBtn"); await settle(host);
    ok((await host.textContent("#hRoles")).includes("حارس"), "انضافت شخصية جديدة");
    ok((await host.textContent("#hSummary")).includes("6 شخصية خاصة + 1 مواطن"), "حسبة المواطنين صح (7 لاعبين: 2 مافيا + 4 خاصين + 1 مواطن)");
    // too many roles blocks dealing
    for (let i = 0; i < 3; i++) await host.click('[data-inc="0"]');
    await settle(host);
    ok(await host.isDisabled("#dealBtn"), "زر التوزيع مسكّر لما الشخصيات أكثر من اللاعبين");
    for (let i = 0; i < 3; i++) await host.click('[data-dec="0"]');
    await settle(host);
    ok(!(await host.isDisabled("#dealBtn")), "زر التوزيع رجع يشتغل");
    await noOverflow(host, "صفحة الحكم قبل التوزيع");

    // ---------- deal
    await host.click("#dealBtn");
    await host.waitForSelector("#hostPlay:not([hidden])");
    await Promise.all(ps.map((p) => p.waitForSelector(".pcard .big")));
    const roles = [];
    for (const p of ps) roles.push((await p.textContent(".pcard .big")).trim());
    const idx = (n) => roles.indexOf(n);
    ok(roles.filter((r) => r === "مافيا").length === 2 && idx("حارس") >= 0 && idx("دكتور") >= 0 && idx("محقق") >= 0 && idx("مفتش") >= 0, "التوزيع: " + roles.join("، "));
    const hostTable = await host.textContent("#hTable");
    ok(roles.every((r) => hostTable.includes(r)), "الحكم شايف كل الشخصيات");
    for (const p of ps) ok(!(await p.textContent("#pPlayers")).match(/مافيا|دكتور|محقق|مفتش|حارس/), "اللاعب ما بيشوف شخصيات غيره");
    const mafia = ps.filter((_, i) => roles[i] === "مافيا"), town = ps.filter((_, i) => roles[i] !== "مافيا");
    ok(await mafia[0].isVisible("#mafiaPanel"), "المافيا شايفين غرفة المافيا");
    ok(!(await town[0].isVisible("#mafiaPanel")), "المدينة ما بتشوف غرفة المافيا");
    ok((await mafia[0].textContent(".pcard")).includes("معك بالمافيا"), "المافيا بيعرفوا بعض");
    for (const p of ps) await noOverflow(p, "شاشة اللاعب بالليل");

    // hide / show card
    await ps[0].click("[data-hide]"); ok(await ps[0].isVisible(".pcard.back"), "خبّي الكرت بيشتغل");
    await ps[0].click("[data-flip]"); ok(!(await ps[0].isVisible(".pcard.back")), "الكرت برجع يبين");

    // refresh keeps role
    const before = (await ps[2].textContent(".pcard .big")).trim();
    await ps[2].reload(); await ps[2].waitForSelector(".pcard .big");
    ok((await ps[2].textContent(".pcard .big")).trim() === before, "بعد تحديث الصفحة نفس الشخصية");

    // ---------- night 1
    const nameOf = (i) => names[i];
    const tap = async (p, scope, name) => {
      const btn = (await p.$$(`${scope} .tgt`)).length ? await p.evaluateHandle(([sc, n]) => [...document.querySelectorAll(sc + " .tgt")].find((b) => b.querySelector(".tname").textContent === n), [scope, name]) : null;
      assert.ok(btn && (await btn.evaluate((b) => !!b)), `ما لقيت "${name}" بـ ${scope}`);
      await btn.asElement().click(); await settle(p, 150);
    };
    const victim = town.find((p) => ![idx("دكتور"), idx("حارس")].includes(ps.indexOf(p)) && roles[ps.indexOf(p)] === "مواطن");
    const victimName = nameOf(ps.indexOf(victim));
    await tap(mafia[0], "#mafiaPanel", victimName);
    await mafia[0].fill("#mChatIn", "يلا نطلع " + victimName); await mafia[0].press("#mChatIn", "Enter"); await settle(mafia[0]);
    ok((await mafia[1].textContent("#mChat")).includes("يلا نطلع"), "دردشة المافيا وصلت للشريك");
    ok((await mafia[1].textContent("#mafiaPanel")).includes(nameOf(ps.indexOf(mafia[0]))), "اقتراح الشريك ظاهر");
    await tap(mafia[1], "#mafiaPanel", victimName);
    await mafia[1].click("[data-msend]"); await settle(host);
    ok((await host.textContent("#hReport")).includes(victimName), "قرار المافيا وصل للحكم");
    ok((await mafia[0].textContent("#mafiaPanel")).includes("بعت للحكم"), "المافيا شايفين مين بعت");

    const doc = ps[idx("دكتور")], det = ps[idx("محقق")], guard = ps[idx("حارس")];
    await tap(doc, "#pAction", victimName);
    ok((await doc.textContent("#pAction")).includes("وصل للحكم"), "الدكتور اختار ووصل");
    await tap(guard, "#pAction", nameOf(ps.indexOf(doc)));
    ok((await guard.textContent("#pAction")).includes("وصل للحكم"), "الشخصية الجديدة بتختار بالليل");
    const mafiaName = nameOf(ps.indexOf(mafia[0]));
    await tap(det, "#pAction", mafiaName); await settle(host);
    ok((await host.textContent("#hReport")).includes("حارس"), "تقرير الحكم فيه الشخصية الجديدة");
    await host.click(`[data-ans="mafia"][data-pid]`); await settle(det);
    ok((await det.textContent("#pAction")).includes("ردّ الحكم: " + mafiaName + " مافيا"), "المحقق وصله رد الحكم");
    ok(!(await doc.innerText("#playerPanel")).includes("ردّ الحكم"), "الرد ما وصل لغير المحقق");
    const citizen = ps[idx("مواطن")];
    ok((await citizen.textContent("#pAction")).includes("نام"), "المواطن بالليل بيستنى");

    // ---------- mafia kill announced
    await clickRow(host, "#hTable li", ".nm", victimName); await settle(host, 400);
    for (const p of ps.filter((p) => p !== victim)) {
      ok(await p.isVisible("#overlay"), "بطاقة الطرد طلعت");
      const t = await p.textContent("#overlay");
      ok(t.includes(victimName) && t.includes("مواطن صالح"), "البطاقة بتقول مواطن صالح");
      await dismiss(p);
    }
    ok((await victim.textContent("#overlay")).includes("إنت"), "اللي انطرد بتطلعله بطاقة إنه انطرد");
    await dismiss(victim);
    ok(!(await host.isVisible("#overlay")), "الحكم ما بتطلعله البطاقة");
    ok((await victim.textContent("#pAction")).includes("انطردت"), "اللي انطرد ما بيقدر يعمل اشي");
    ok((await ps.find((p) => p !== victim).textContent("#pPlayers")).includes("انشطب"), "الاسم مشطوب عند الكل");

    // ---------- day & vote
    const tA = town.filter((p) => p !== victim);
    await host.click('[data-phase="day"]'); await settle(host);
    ok((await tA[0].textContent("#pPhase")).includes("النهار"), "النهار بلّش");
    await host.click('[data-phase="vote"]'); await settle(host);
    const voters = ps.filter((p) => p !== victim);
    const target2 = nameOf(ps.indexOf(mafia[1]));
    for (const p of voters) if (p !== mafia[1]) await tap(p, "#pAction", target2);
    await tap(mafia[1], "#pAction", nameOf(ps.indexOf(town.find((p) => p !== victim))));
    await settle(host);
    const badge = (p) => p.evaluate((n) => [...document.querySelectorAll("#pAction .tgt")].find((b) => b.querySelector(".tname").textContent === n).querySelector(".vc").textContent.trim(), target2);
    ok((await badge(tA[0])) === "5", "العداد 5 عند الكل");
    // un-vote: counter goes down everywhere
    await tap(tA[0], "#pAction", target2); await settle(tA[1]);
    ok((await badge(tA[1])) === "4", "شيل الصوت بينزّل العداد عند الكل");
    ok((await host.textContent("#hVotes")).includes("لسا ما صوّتوا"), "الحكم شايف مين لسا ما صوّت");
    await tap(tA[0], "#pAction", target2); await settle(host);
    ok((await host.textContent("#hVotes")).includes("الكل صوّت"), "الحكم شايف إنه الكل صوّت");
    for (const p of voters) await noOverflow(p, "شاشة التصويت");

    // ---------- vote out a mafia
    await clickRow(host, "#hVotes li", "b", target2); await settle(host, 400);
    ok((await tA[0].textContent("#overlay")).includes("مافيا"), "بطاقة الطرد بتقول مافيا");
    for (const p of ps) await dismiss(p);
    ok(!(await host.isVisible("#overPanel")), "اللعبة لسا ما خلصت (1 مافيا ضد 4)");

    // ---------- night 2: mafia kills again, then vote out the last mafia
    await host.click('[data-phase="night"]'); await settle(host);
    ok((await town[0].textContent("#pPhase")).includes("الليل 2"), "الليل الثاني");
    ok(!(await mafia[1].isVisible("#mafiaPanel")), "المافيا اللي انطرد طلع من غرفة المافيا");
    await host.click('[data-phase="vote"]'); await settle(host);
    await clickRow(host, "#hTable li", ".nm", mafiaName); await settle(host, 500);
    for (const p of [host, ...ps]) { await dismiss(p); ok(await p.isVisible("#overPanel"), "شاشة النهاية طلعت"); }
    ok((await town[0].textContent("#overPanel")).includes("فازت المدينة"), "المدينة فازت");
    { const t = await town[0].textContent("#overPanel"); ok(roles.every((r) => t.includes(r)), "الكل بيشوف الشخصيات بالآخر"); }
    ok((await town[0].textContent("#overPanel")).includes("دكتور"), "شخصية الدكتور بتبين بالآخر");
    ok(!(await town[0].isVisible("#pAction .tgt")), "ما في تصويت بعد النهاية");
    ok(await host.isVisible("[data-again]"), "زر العب كمان مرة عند الحكم");
    ok(!(await town[0].isVisible("[data-again]")), "اللاعب ما عنده زر الإعادة");
    await noOverflow(town[0], "شاشة النهاية");

    // ---------- play again
    await host.click("[data-again]"); await settle(host, 500);
    for (const p of ps) {
      ok(!(await p.isVisible("#overPanel")), "شاشة النهاية راحت");
      ok(!(await p.textContent("#pPlayers")).includes("انشطب"), "الكل رجع باللعبة");
      ok(await p.isVisible(".pcard .big"), "شخصية جديدة");
    }
    ok((await host.textContent("#statusPill")).includes("اللفة 2"), "لفة 2");

    // ---------- back to lobby & home/resume
    await host.click("#endBtn"); await host.click("#endYes"); await settle(host, 400);
    ok(await host.isVisible("#hostLobby"), "الحكم رجع لصفحة الانتظار");
    ok((await ps[0].textContent("#pCardBox")).includes("بانتظار الحكم"), "اللاعبين رجعوا للانتظار");
    await ps[1].click("#brandBtn"); await ps[1].waitForSelector("#vHome:not([hidden])");
    ok(await ps[1].isVisible("#resumeBtn"), "زر ارجع لغرفتك ظاهر");
    await ps[1].click("#resumeBtn"); await ps[1].waitForSelector("#playerPanel:not([hidden])");
    ok(true, "رجع للغرفة من الصفحة الرئيسية");
    await ps[2].click("#leaveBtn"); await settle(host, 300);
    ok((await host.$$("#hPlayers li")).length === 6, "اللي غادر انشال من القائمة");

    // ---------- desktop width
    await host.setViewportSize({ width: 1280, height: 900 });
    await noOverflow(host, "شاشة كمبيوتر");

    ok(errors.length === 0, "ما في أخطاء JavaScript: " + errors.join(" | "));
    console.log(`✔ ${checks.length} فحص بالمتصفح نجحوا`);
  } catch (e) {
    console.error("✖ فشل بعد " + checks.length + " فحص:", e.message);
    if (errors.length) console.error("JS errors:", errors);
    process.exitCode = 1;
  } finally {
    await b.close();
    srv.kill();
  }
})();
