'use strict';
// ديوانية الألعاب — سيرفر بدون أي مكتبات خارجية (Node فقط)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONTENT = {
  lie: require('./content/lie'),
  who: require('./content/who'),
  tf: require('./content/tf'),
  emoji: require('./content/emoji'),
};

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 12;
const OFFLINE_GRACE = 20000; // ننطر اللاعب ٢٠ ثانية إذا انقطع قبل لا نمشي بدونه
const PUBLIC = path.join(__dirname, 'public');

const GAMES = {
  lie:   { name: 'كذبة الديوانية', icon: '🎭', desc: 'اكتب كذبة تمشي على الربع… واكشف چذبهم', rounds: 5, min: 2, color: '#ff4d6d' },
  who:   { name: 'منو فينا؟',      icon: '👀', desc: 'صوّتوا على بعض… والفضايح على الشاشة',     rounds: 6, min: 2, color: '#ffc23d' },
  tf:    { name: 'صج ولا چذب؟',   icon: '⚡', desc: 'معلومة سريعة… والأسرع ياخذ أكثر',          rounds: 8, min: 1, color: '#2ee59d' },
  emoji: { name: 'حزّر الإيموجي', icon: '🧩', desc: 'حل لغز الإيموجي قبل الكل',                 rounds: 8, min: 1, color: '#4cc9f0' },
  mafia: { name: 'مافيا الديوانية', icon: '🕵️', desc: 'بيننا مافيا… اكشفوهم قبل لا يخلصون عليكم', rounds: 0, min: 4, color: '#b388ff' },
};
const TIME = { intro: 7, write: 90, vote: 40, who: 25, tf: 12, emoji: 15, scores: 8, roles: 30, night: 45, dawn: 9, discuss: 120, mvote: 45, mresult: 9 };
const MIN_NIGHT = 15000;
const ROLES = { mafia: 'مافيا', doctor: 'دكتور', cop: 'شرطي', citizen: 'مواطن' };
const COLORS = ['#ff4d6d', '#ffc23d', '#2ee59d', '#4cc9f0', '#b388ff', '#ff8fab', '#90be6d', '#f77f00', '#3a86ff', '#e9ff70', '#00f5d4', '#f15bb5'];
const AVATARS = ['🐪', '🦅', '🐟', '🦁', '🐬', '🦊', '🐼', '🐸', '🦄', '🐯', '🐙', '🦩'];

const rooms = new Map();
const rnd = n => Math.floor(Math.random() * n);
const uid = () => Math.random().toString(36).slice(2, 10);
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function newCode() { const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c; do { c = ''; for (let i = 0; i < 4; i++) c += L[rnd(L.length)]; } while (rooms.has(c)); return c; }

// توحيد النص للمقارنة
function norm(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 1632))
    .replace(/[ً-ٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/چ/g, 'ك').replace(/گ/g, 'ق')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(/\s+/).filter(Boolean).map(w => w.replace(/^ال(?=..)/, '')).join(' ');
}

function createRoom() {
  const r = {
    code: newCode(), hostKey: uid() + uid(), players: new Map(), phase: 'lobby', game: null,
    round: 0, rounds: 0, item: null, decks: {}, lies: new Map(), votes: new Map(), answers: new Map(),
    options: [], reveal: null, deadline: 0, phaseSecs: 0, timer: null, clients: new Set(), touched: Date.now(),
  };
  rooms.set(r.code, r);
  return r;
}

const activePlayers = r => [...r.players.values()].filter(p => p.conns > 0 || Date.now() - p.offSince < OFFLINE_GRACE);
const mult = r => (r.round === r.rounds ? 2 : 1);

// نسحب سؤال من الكومة بدون تكرار لين تخلص
function nextItem(r) {
  const list = CONTENT[r.game];
  let d = r.decks[r.game];
  if (!d || d.pos >= d.order.length) d = r.decks[r.game] = { order: shuffle(list.map((_, i) => i)), pos: 0 };
  return list[d.order[d.pos++]];
}

function setPhase(r, phase, secs) {
  clearTimeout(r.timer);
  r.phase = phase;
  r.phaseSecs = secs || 0;
  r.phaseStart = Date.now();
  r.deadline = secs ? Date.now() + secs * 1000 : 0;
  if (secs) r.timer = setTimeout(() => advance(r), secs * 1000);
  broadcast(r);
}

function startGame(r, game) {
  r.game = game; r.round = 0; r.rounds = GAMES[game].rounds;
  for (const p of r.players.values()) p.score = 0;
  r.reveal = null; r.m = null;
  if (game === 'mafia') setupMafia(r);
  setPhase(r, 'intro', TIME.intro);
}

// ---------- مافيا الديوانية ----------
function setupMafia(r) {
  const ids = shuffle(activePlayers(r).map(p => p.id));
  const n = ids.length;
  const mafiaCount = n >= 10 ? 3 : n >= 7 ? 2 : 1;
  const roles = new Map();
  ids.forEach((id, i) => roles.set(id, i < mafiaCount ? 'mafia' : i === mafiaCount ? 'doctor' : i === mafiaCount + 1 ? 'cop' : 'citizen'));
  r.m = { roles, alive: new Set(ids), ready: new Set(), acts: new Map(), votes: new Map(), checks: new Map(), dawn: null, out: null, winner: null, mafiaCount };
  r.round = 1;
}

function mafiaWinner(r) {
  const M = r.m;
  const mafiaAlive = [...M.alive].filter(id => M.roles.get(id) === 'mafia').length;
  const town = M.alive.size - mafiaAlive;
  if (mafiaAlive === 0) return 'town';
  if (mafiaAlive >= town) return 'mafia';
  return null;
}

function finishMafiaCheck(r) {
  const M = r.m;
  M.winner = mafiaWinner(r);
  if (M.winner) for (const [id, role] of M.roles) { const p = r.players.get(id); if (p && ((role === 'mafia') === (M.winner === 'mafia'))) p.score += 1000; }
}

function resolveNight(r) {
  const M = r.m, tally = new Map();
  let saved = null;
  for (const [pid, t] of M.acts) {
    if (!M.alive.has(pid)) continue;
    const role = M.roles.get(pid);
    if (role === 'mafia') tally.set(t, (tally.get(t) || 0) + 1);
    else if (role === 'doctor') saved = t;
    else if (role === 'cop') { if (!M.checks.has(pid)) M.checks.set(pid, []); M.checks.get(pid).push({ target: t, mafia: M.roles.get(t) === 'mafia', day: r.round }); }
  }
  let victim = null;
  if (tally.size) { const max = Math.max(...tally.values()); victim = shuffle([...tally].filter(([, c]) => c === max).map(([t]) => t))[0]; }
  const wasSaved = !!victim && victim === saved;
  if (victim && !wasSaved) M.alive.delete(victim);
  M.dawn = { victim: wasSaved ? null : victim, saved: wasSaved };
  M.acts.clear();
  finishMafiaCheck(r);
  setPhase(r, 'dawn', TIME.dawn);
}

function resolveMafiaVote(r) {
  const M = r.m, tally = new Map();
  let skips = 0;
  for (const [pid, t] of M.votes) { if (!M.alive.has(pid)) continue; if (t === 'skip') skips++; else tally.set(t, (tally.get(t) || 0) + 1); }
  const list = [...tally].map(([id, votes]) => ({ id, votes })).sort((a, b) => b.votes - a.votes);
  let out = null;
  if (list.length && (list.length === 1 || list[0].votes > list[1].votes) && list[0].votes > skips) out = list[0].id;
  if (out) M.alive.delete(out);
  M.out = { id: out, list, skips };
  M.votes.clear();
  finishMafiaCheck(r);
  setPhase(r, 'mresult', TIME.mresult);
}

function startRound(r) {
  r.round++;
  r.item = nextItem(r);
  r.lies.clear(); r.votes.clear(); r.answers.clear(); r.options = []; r.reveal = null;
  if (r.game === 'lie') return setPhase(r, 'write', TIME.write);
  if (r.game === 'emoji') r.options = shuffle([r.item.a, ...r.item.o]);
  setPhase(r, 'answer', TIME[r.game]);
}

// ---------- كذبة الديوانية ----------
function startVote(r) {
  const opts = [];
  for (const [pid, text] of r.lies) opts.push({ id: uid(), text, authors: [pid] });
  const used = new Set(opts.map(o => norm(o.text)));
  let need = Math.max(0, 3 - opts.length);
  for (const h of shuffle(r.item.lies)) {
    if (need <= 0) break;
    if (used.has(norm(h))) continue;
    opts.push({ id: uid(), text: h, authors: [], house: true });
    used.add(norm(h)); need--;
  }
  opts.push({ id: uid(), text: r.item.a, authors: [], truth: true });
  r.options = shuffle(opts);
  setPhase(r, 'vote', TIME.vote);
}

function lieReveal(r) {
  const m = mult(r), gains = zeroGains(r);
  const items = r.options.map(o => ({ ...o, voters: [] }));
  const byId = Object.fromEntries(items.map(o => [o.id, o]));
  for (const [pid, oid] of r.votes) {
    const o = byId[oid]; if (!o) continue;
    o.voters.push(pid);
    if (o.truth) gains[pid] += 1000 * m;
    else for (const a of o.authors) if (a !== pid) gains[a] += 500 * m;
  }
  applyGains(r, gains);
  const shown = items.filter(o => !o.truth && o.voters.length).concat(items.filter(o => o.truth));
  r.reveal = { items: shown, gains };
  setPhase(r, 'reveal', 5 + shown.length * 4);
}

// ---------- الألعاب السريعة ----------
function quickReveal(r) {
  const m = mult(r), gains = zeroGains(r);
  const total = r.phaseSecs * 1000, end = r.deadline;
  const speed = t => Math.round(500 + 500 * Math.max(0, Math.min(1, (end - t) / total)));
  if (r.game === 'who') {
    const counts = new Map();
    for (const [pid, a] of r.answers) { if (!counts.has(a.value)) counts.set(a.value, []); counts.get(a.value).push(pid); }
    const list = [...counts.entries()].map(([id, voters]) => ({ id, voters })).sort((a, b) => b.voters.length - a.voters.length);
    const max = list.length ? list[0].voters.length : 0;
    const top = list.filter(x => x.voters.length === max).map(x => x.id);
    for (const [pid, a] of r.answers) if (top.includes(a.value)) gains[pid] += 500 * m;
    r.reveal = { counts: list, top, gains };
  } else {
    const correct = r.game === 'tf' ? r.item.a : r.item.a;
    const right = [], wrong = [];
    for (const [pid, a] of r.answers) {
      if (a.value === correct) { right.push(pid); gains[pid] += speed(a.t) * m; } else wrong.push(pid);
    }
    right.sort((x, y) => r.answers.get(x).t - r.answers.get(y).t);
    r.reveal = { right, wrong, gains };
  }
  applyGains(r, gains);
  setPhase(r, 'reveal', r.game === 'who' ? 9 : 6);
}

function zeroGains(r) { const g = {}; for (const id of r.players.keys()) g[id] = 0; return g; }
function applyGains(r, gains) { for (const [id, g] of Object.entries(gains)) { const p = r.players.get(id); if (p) p.score += g; } }

function advance(r) {
  const last = r.round >= r.rounds;
  if (r.game === 'mafia') {
    const M = r.m;
    switch (r.phase) {
      case 'intro': return setPhase(r, 'roles', TIME.roles);
      case 'roles': return setPhase(r, 'night', TIME.night);
      case 'night': return resolveNight(r);
      case 'dawn': return M.winner ? setPhase(r, 'end', 0) : setPhase(r, 'discuss', TIME.discuss);
      case 'discuss': return setPhase(r, 'mvote', TIME.mvote);
      case 'mvote': return resolveMafiaVote(r);
      case 'mresult': if (M.winner) return setPhase(r, 'end', 0); r.round++; return setPhase(r, 'night', TIME.night);
    }
    return;
  }
  switch (r.phase) {
    case 'intro': return startRound(r);
    case 'write': return startVote(r);
    case 'vote': return lieReveal(r);
    case 'answer': return quickReveal(r);
    case 'reveal':
      if (last) return setPhase(r, 'end', 0);
      if (r.game === 'lie') return setPhase(r, 'scores', TIME.scores);
      return startRound(r);
    case 'scores': return startRound(r);
  }
}

function mafiaDoneMap(r) {
  if (r.game !== 'mafia' || !r.m) return null;
  return { roles: r.m.ready, night: r.m.acts, mvote: r.m.votes }[r.phase] || null;
}

function checkAllDone(r) {
  if (r.game === 'mafia' && r.m) {
    const map = mafiaDoneMap(r); if (!map) return;
    const need = activePlayers(r).filter(p => r.m.roles.has(p.id) && (r.phase === 'roles' || r.m.alive.has(p.id)));
    if (!need.length || !need.every(p => map.has(p.id))) return;
    // الليل ما يخلص قبل ١٥ ثانية عشان محد ينفضح من سرعته
    const wait = r.phase === 'night' ? MIN_NIGHT - (Date.now() - r.phaseStart) : 0;
    if (wait > 0) { const ph = r.phase, day = r.round; setTimeout(() => { if (r.phase === ph && r.round === day) checkAllDone(r); }, wait + 50); return; }
    advance(r);
    return;
  }
  const act = activePlayers(r);
  if (!act.length) return;
  const map = { write: r.lies, vote: r.votes, answer: r.answers }[r.phase];
  if (map && act.every(p => map.has(p.id))) advance(r);
}

// ---------- اللي يشوفه كل واحد ----------
function view(r, pid) {
  const pinfo = id => { const p = r.players.get(id); return p ? { id: p.id, name: p.name, color: p.color, avatar: p.avatar } : { name: '؟', color: '#888', avatar: '❔' }; };
  const doneMap = mafiaDoneMap(r) || { write: r.lies, vote: r.votes, answer: r.answers }[r.phase];
  const v = {
    code: r.code, phase: r.phase, game: r.game, round: r.round, rounds: r.rounds, deadline: r.deadline,
    phaseSecs: r.phaseSecs, now: Date.now(), mult: mult(r),
    games: Object.entries(GAMES).map(([id, g]) => ({ id, ...g })),
    players: [...r.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, avatar: p.avatar, score: p.score, connected: p.conns > 0, done: doneMap ? doneMap.has(p.id) : false,
    })),
  };
  const it = r.item, ph = r.phase, inRound = ['write', 'vote', 'answer', 'reveal', 'scores', 'end'].includes(ph) && it;
  if (inRound) {
    if (r.game === 'lie') {
      v.question = it.q;
      if (['reveal', 'scores', 'end'].includes(ph)) v.answer = it.a;
      if (ph === 'vote') v.options = r.options.map(o => ({ id: o.id, text: o.text }));
      if (ph === 'reveal' && r.reveal) v.reveal = r.reveal.items.map(o => ({ text: o.text, truth: !!o.truth, house: !!o.house, authors: o.authors.map(pinfo), voters: o.voters.map(pinfo) }));
    } else if (r.game === 'who') {
      v.prompt = it;
      if (ph === 'reveal' && r.reveal) v.reveal = { counts: r.reveal.counts.map(c => ({ ...pinfo(c.id), votes: c.voters.length, voters: c.voters.map(pinfo) })), top: r.reveal.top };
    } else if (r.game === 'tf') {
      v.statement = it.s;
      if (ph === 'reveal') v.reveal = { truth: it.a, note: it.note, right: r.reveal.right.map(pinfo), wrong: r.reveal.wrong.map(pinfo) };
    } else if (r.game === 'emoji') {
      v.emoji = it.e; v.options = r.options;
      if (ph === 'reveal') v.reveal = { answer: it.a, right: r.reveal.right.map(pinfo), wrong: r.reveal.wrong.map(pinfo) };
    }
  }
  if (r.reveal && ['reveal', 'scores', 'end'].includes(ph)) v.gains = r.reveal.gains;
  if (r.game === 'mafia' && r.m) {
    const M = r.m, withRole = id => ({ ...pinfo(id), role: M.roles.get(id) });
    v.mafia = {
      day: r.round, mafiaCount: M.mafiaCount, alive: [...M.alive],
      inGame: [...M.roles.keys()],
      dead: [...M.roles.keys()].filter(id => !M.alive.has(id)).map(withRole),
      winner: ph === 'end' ? M.winner : null,
    };
    if (ph === 'dawn' && M.dawn) v.mafia.dawn = { victim: M.dawn.victim ? withRole(M.dawn.victim) : null, saved: M.dawn.saved };
    if (ph === 'mresult' && M.out) v.mafia.out = { victim: M.out.id ? withRole(M.out.id) : null, list: M.out.list.map(x => ({ ...pinfo(x.id), votes: x.votes })), skips: M.out.skips };
    if (ph === 'end') v.mafia.roles = [...M.roles.keys()].map(id => ({ ...withRole(id), alive: M.alive.has(id) }));
    if (pid && M.roles.has(pid)) {
      const role = M.roles.get(pid);
      v.mafia.me = {
        role, alive: M.alive.has(pid),
        team: role === 'mafia' ? [...M.roles].filter(([id, rl]) => rl === 'mafia' && id !== pid).map(([id]) => pinfo(id)) : [],
        checks: (M.checks.get(pid) || []).map(c => ({ ...pinfo(c.target), mafia: c.mafia, day: c.day })),
        myAct: M.acts.get(pid) || null, myVote: M.votes.get(pid) || null,
      };
    }
  }
  if (pid) {
    const p = r.players.get(pid);
    v.me = p ? { id: p.id, name: p.name, color: p.color, avatar: p.avatar, score: p.score } : null;
    const md = mafiaDoneMap(r);
    v.answered = md ? md.has(pid) : (r.lies.has(pid) || r.answers.has(pid));
    v.myLie = r.lies.get(pid) || null;
    v.voted = r.votes.has(pid);
    const a = r.answers.get(pid); v.myAnswer = a ? a.value : null;
    if (ph === 'vote') { const own = r.options.find(o => o.authors.includes(pid)); v.myOption = own ? own.id : null; }
  }
  return v;
}

function broadcast(r) {
  r.touched = Date.now();
  for (const c of r.clients) c.res.write(`data: ${JSON.stringify(view(r, c.pid))}\n\n`);
}

// ---------- الأوامر ----------
function hostAction(r, b) {
  const type = b.type;
  if (type === 'start') {
    const g = GAMES[b.game];
    if (!g) throw 'لعبة مو موجودة';
    if (!['lobby', 'end'].includes(r.phase)) throw 'فيه لعبة شغالة';
    if (activePlayers(r).length < g.min) throw `هاللعبة تبي ${g.min === 1 ? 'لاعب واحد' : g.min + ' لاعبين'} على الأقل`;
    startGame(r, b.game);
  } else if (type === 'again') {
    if (!r.game) throw 'ما فيه لعبة';
    startGame(r, r.game);
  } else if (type === 'menu') {
    clearTimeout(r.timer); r.game = null; r.round = 0; r.reveal = null; setPhase(r, 'lobby', 0);
  } else if (type === 'next') {
    if (['intro', 'write', 'vote', 'answer', 'reveal', 'scores', 'roles', 'night', 'dawn', 'discuss', 'mvote', 'mresult'].includes(r.phase)) advance(r);
  } else throw 'أمر غير معروف';
}

function playerAction(r, p, b) {
  const type = b.type;
  if (type === 'answer') { // كذبة
    if (r.phase !== 'write') throw 'خلص الوقت!';
    if (r.lies.has(p.id)) throw 'كتبت كذبتك خلاص';
    const text = String(b.text || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!norm(text)) throw 'اكتب شي!';
    if ([r.item.a, ...r.item.alt].some(x => norm(x) === norm(text))) throw 'هذا الجواب الصج! 😅 نبي كذبة';
    for (const t of r.lies.values()) if (norm(t) === norm(text)) throw 'واحد سابقك عليها، اكتب غيرها';
    r.lies.set(p.id, text);
  } else if (type === 'vote') { // تصويت الكذبة
    if (r.phase !== 'vote') throw 'خلص التصويت';
    if (r.votes.has(p.id)) throw 'صوّتت خلاص';
    const o = r.options.find(x => x.id === b.optionId);
    if (!o) throw 'خيار مو موجود';
    if (o.authors.includes(p.id)) throw 'لا تصوّت لكذبتك يا حلو 😏';
    r.votes.set(p.id, o.id);
  } else if (type === 'pick') { // الألعاب السريعة
    if (r.phase !== 'answer') throw 'خلص الوقت!';
    if (r.answers.has(p.id)) throw 'جاوبت خلاص';
    let value = b.value;
    if (r.game === 'who' && !r.players.has(value)) throw 'اختار واحد من الربع';
    if (r.game === 'tf') value = value === true;
    if (r.game === 'emoji' && !r.options.includes(value)) throw 'خيار مو موجود';
    r.answers.set(p.id, { value, t: Date.now() });
  } else if (type.startsWith('m')) { // مافيا
    const M = r.m;
    if (r.game !== 'mafia' || !M) throw 'مو وقت المافيا';
    if (!M.roles.has(p.id)) throw 'أنت تتفرّج هاللعبة 👀';
    const role = M.roles.get(p.id), t = b.target;
    if (type === 'mready') {
      if (r.phase !== 'roles') throw 'خلص الوقت';
      M.ready.add(p.id);
    } else if (type === 'mnight') {
      if (r.phase !== 'night') throw 'الليل خلص';
      if (!M.alive.has(p.id)) throw 'أنت ميت 💀';
      if (M.acts.has(p.id)) throw 'اخترت خلاص';
      if (role === 'citizen') { // المواطن يختار منو يشك فيه (نفس حركة الباجين عشان محد ينفضح)
        if (t !== 'sleep' && !M.alive.has(t)) throw 'اختار واحد عايش';
        M.acts.set(p.id, t || 'sleep');
      } else {
        if (!M.alive.has(t)) throw 'اختار واحد عايش';
        if (role === 'mafia' && M.roles.get(t) === 'mafia') throw 'هذا من ربعك المافيا! 😅';
        if (role === 'cop' && t === p.id) throw 'تحقق في نفسك؟ 😂';
        M.acts.set(p.id, t);
      }
    } else if (type === 'mvote') {
      if (r.phase !== 'mvote') throw 'خلص التصويت';
      if (!M.alive.has(p.id)) throw 'الميت ما يصوّت 💀';
      if (M.votes.has(p.id)) throw 'صوّتت خلاص';
      if (t !== 'skip' && !M.alive.has(t)) throw 'اختار واحد عايش';
      M.votes.set(p.id, t);
    } else throw 'أمر غير معروف';
  } else throw 'أمر غير معروف';
  broadcast(r); checkAllDone(r);
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((res, rej) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e4) { rej('كبير'); req.destroy(); } });
    req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch { rej('JSON غلط'); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const getRoom = c => rooms.get(String(c || '').toUpperCase().trim());

function lanUrl() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return `http://${i.address}:${PORT}`;
  return `http://localhost:${PORT}`;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/info') return send(res, 200, { lan: lanUrl() });

    if (p === '/api/create' && req.method === 'POST') {
      const b = await readBody(req);
      const old = getRoom(b.code);
      const r = old && old.hostKey === b.hostKey ? old : createRoom();
      return send(res, 200, { code: r.code, hostKey: r.hostKey });
    }

    if (p === '/api/join' && req.method === 'POST') {
      const b = await readBody(req);
      const r = getRoom(b.code);
      if (!r) return send(res, 404, { error: 'ما لقينا غرفة بهالرمز، تأكد منه' });
      if (b.pid && r.players.has(b.pid)) return send(res, 200, { pid: b.pid, code: r.code });
      if (b.pid && !b.name) return send(res, 404, { error: 'طلعت من اللعبة، ادخل من جديد' });
      const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 14);
      if (!name) return send(res, 400, { error: 'اكتب اسمك' });
      if (r.players.size >= MAX_PLAYERS) return send(res, 400, { error: 'الغرفة فل، ما فيها مكان' });
      if ([...r.players.values()].some(x => norm(x.name) === norm(name))) return send(res, 400, { error: 'هالاسم مأخوذ، اختار غيره' });
      const n = r.players.size;
      const pl = { id: uid(), name, color: COLORS[n % COLORS.length], avatar: AVATARS[n % AVATARS.length], score: 0, conns: 0, offSince: Date.now() };
      r.players.set(pl.id, pl);
      broadcast(r);
      return send(res, 200, { pid: pl.id, code: r.code });
    }

    if (p === '/api/action' && req.method === 'POST') {
      const b = await readBody(req);
      const r = getRoom(b.code);
      if (!r) return send(res, 404, { error: 'الغرفة خلصت' });
      if (b.hostKey) { if (b.hostKey !== r.hostKey) return send(res, 403, { error: 'مو مسموح' }); hostAction(r, b); }
      else { const pl = r.players.get(b.pid); if (!pl) return send(res, 404, { error: 'طلعت من اللعبة' }); playerAction(r, pl, b); }
      return send(res, 200, { ok: true });
    }

    if (p === '/api/events') {
      const r = getRoom(url.searchParams.get('code'));
      if (!r) { res.writeHead(404); return res.end(); }
      const host = url.searchParams.get('host');
      const pid = url.searchParams.get('pid');
      if (host ? host !== r.hostKey : !r.players.has(pid)) { res.writeHead(403); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const client = { res, pid: host ? null : pid };
      r.clients.add(client);
      const pl = pid && r.players.get(pid);
      if (pl) pl.conns++;
      broadcast(r);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping); r.clients.delete(client);
        if (pl) { pl.conns = Math.max(0, pl.conns - 1); if (!pl.conns) { pl.offSince = Date.now(); setTimeout(() => checkAllDone(r), OFFLINE_GRACE + 500); } }
        broadcast(r);
      });
      return;
    }

    // ملفات ثابتة
    const file = p === '/' ? '/index.html' : p === '/host' ? '/host.html' : p;
    const full = path.normalize(path.join(PUBLIC, decodeURIComponent(file)));
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store, must-revalidate' });
      res.end(data);
    });
  } catch (e) {
    send(res, 400, { error: typeof e === 'string' ? e : 'صار خطأ' });
    if (typeof e !== 'string') console.error(e);
  }
}

setInterval(() => {
  for (const [c, r] of rooms) if (!r.clients.size && Date.now() - r.touched > 2 * 3600e3) { clearTimeout(r.timer); rooms.delete(c); }
}, 10 * 60e3);

http.createServer(handle).listen(PORT, () => {
  console.log('\n🎉  ديوانية الألعاب شغّالة!');
  console.log(`📺  الشاشة الكبيرة (تلفزيون/لابتوب):  http://localhost:${PORT}/host`);
  console.log(`📱  الربع يدخلون من تلفوناتهم:        ${lanUrl()}\n`);
});
