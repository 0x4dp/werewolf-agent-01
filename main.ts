/**
 * main.ts — entry for the make.fun competition werewolf-agent-01.
 *
 * The agent holds one seat in each of 30 games of 8-player Werewolf; the other
 * seven seats are house players. Its team's results are its score, so the whole
 * design is about *winning*, not about sounding clever.
 *
 * Shape of the program:
 *   1. transport  — POST /observe and POST /act, sequential, with one retry on
 *                   429/5xx and a safe fallback (pass / abstain) on any error;
 *   2. reading    — every decision rebuilds a GameState from the view's public
 *                   log: who claimed seer, what they claimed to have checked,
 *                   who accused whom, how every vote was cast, what the exiles
 *                   revealed. That derived state *is* the cross-decision memory
 *                   (the log never loses it), and a small per-game slot keeps
 *                   the private plan (a wolf's fabricated seer claim);
 *   3. judgement  — a suspicion score per seat, built from hard information
 *                   first (seer results, believed claims) and soft evidence
 *                   second (votes for players later revealed as villagers,
 *                   bandwagoning, accusations, silence);
 *   4. decisions  — one explicit strategy per role, each of which reasons
 *                   before it answers, then answers with a single action.
 *
 * Determinism: no clock, no Math.random. Every random draw comes from
 * MAKEFUN_TRIAL_SEED and the game number, so a replay sees the same bytes.
 */

import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- the contract

type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';
type DecisionKind = 'speak' | 'vote' | 'kill' | 'protect' | 'inspect';

interface PlayerView {
  seat: number;
  name: string;
  alive: boolean;
  role: Role | null;
}

interface PartnerView {
  seat: number;
  name: string;
  alive: boolean;
}

interface YouView {
  seat: number;
  name: string;
  role: Role;
  alive: boolean;
  partner: PartnerView | null;
}

interface SeerResult {
  night: number;
  seat: number;
  werewolf: boolean;
}

interface WolfVote {
  night: number;
  seat: number;
  target: number | null;
}

interface TallyRow {
  seat: number;
  votes: number;
}

interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  seat?: number | null;
  role?: Role | null;
  died?: number | null;
  target?: number | null;
  text?: string;
  round?: number;
  tally?: TallyRow[];
  order?: number[];
  winner?: 'werewolves' | 'village' | null;
  reason?: string;
  winners?: number[];
}

interface Outcome {
  winner: 'werewolves' | 'village' | null;
  reason: string;
  day: number;
  winners: number[];
}

interface View {
  day: number;
  phase: string;
  you: YouView;
  players: PlayerView[];
  seerResults: SeerResult[] | null;
  lastProtect: { night: number; seat: number | null } | null;
  wolfVotes: WolfVote[] | null;
  log: LogEntry[];
  outcome: Outcome | null;
}

interface Pending {
  game: number;
  decision: DecisionKind;
  options?: number[];
  max_chars?: number;
  view: View;
}

interface Observed {
  games: number;
  finished: number;
  done: boolean;
  pending: Pending[];
}

interface Reply {
  status: number;
  body: unknown;
}

// ---------------------------------------------------------------- small tools

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** One line, trimmed: the env folds statements this way before it measures them. */
const fold = (text: string): string => text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Cuts on a sentence end where possible, counting code points as the env does. */
function clampText(text: string, max: number): string {
  const clean = fold(text);
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  const head = chars.slice(0, max).join('');
  const sentence = head.search(/[.!?][^.!?]*$/u);
  if (sentence > max * 0.5) return head.slice(0, sentence + 1).trim();
  const space = head.search(/\s\S*$/u);
  return (space > 0 ? head.slice(0, space) : head).trim();
}

/** FNV-1a over the seed text: the only entropy the program is allowed. */
function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** A mulberry32 stream keyed by the trial seed and one decision's identity. */
function rngFor(seed: string, game: number, salt: string): () => number {
  let a = (hashSeed(`${seed}/${game}/${salt}`) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededPick<T>(rnd: () => number, items: T[]): T | null {
  if (items.length === 0) return null;
  const i = Math.min(items.length - 1, Math.floor(rnd() * items.length));
  return items[i];
}

// ---------------------------------------------------------------- the view

const aliveSeats = (view: View): number[] => view.players.filter((p) => p.alive).map((p) => p.seat);

const nameOf = (view: View, seat: number): string => view.players.find((p) => p.seat === seat)?.name ?? `seat ${seat}`;

const label = (view: View, seat: number): string => `${nameOf(view, seat)} (${seat})`;

const isAlive = (view: View, seat: number): boolean => view.players.some((p) => p.seat === seat && p.alive);

const revealedRole = (view: View, seat: number): Role | null => view.players.find((p) => p.seat === seat)?.role ?? null;

const teamOf = (role: Role | null): 'werewolves' | 'village' | null =>
  role === null ? null : role === 'werewolf' ? 'werewolves' : 'village';

/** Votes cast so far today, as {voter -> target}; abstentions are kept as null. */
function todayVotes(view: View): { from: number; to: number | null }[] {
  const marker = view.log.reduce((last, e, i) => (e.kind === 'voting' && e.day === view.day ? i : last), -1);
  const out: { from: number; to: number | null }[] = [];
  for (let i = Math.max(marker, 0); i < view.log.length; i += 1) {
    const e = view.log[i];
    if (e.kind === 'vote' && typeof e.seat === 'number') out.push({ from: e.seat, to: e.target ?? null });
  }
  return out;
}

function voteCounts(votes: { from: number; to: number | null }[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const v of votes) if (v.to !== null) counts.set(v.to, (counts.get(v.to) ?? 0) + 1);
  return counts;
}

/** The env exiles a unique plurality only: ties and empty tallies exile nobody. */
function uniqueLeader(counts: Map<number, number>): number | null {
  let best: number | null = null;
  let bestN = 0;
  let tied = false;
  for (const [seat, n] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (n > bestN) {
      best = seat;
      bestN = n;
      tied = false;
    } else if (n === bestN) tied = true;
  }
  return bestN === 0 || tied ? null : best;
}

// ---------------------------------------------------------------- reading claims

interface Claim {
  seat: number;
  day: number;
  seq: number;
  results: { seat: number; werewolf: boolean }[];
  text: string;
}

interface Mention {
  seat: number;
  at: number;
}

const WOLF_WORD = /(werewolf|wolf|wolves|killer)/i;
const CLEAN_WORD = /(not a werewolf|isn'?t a werewolf|not a wolf|not the wolf|no wolf|is clean|was clean|clear|innocent|villager|village team|trust(?:worthy)?)/i;

/** Every seat a statement names, by name or by "seat N" / "#N", in reading order. */
function mentionsOf(view: View, text: string): Mention[] {
  const hits: Mention[] = [];
  const lower = text.toLowerCase();
  for (const p of view.players) {
    const key = p.name.toLowerCase();
    if (key.length < 3) continue;
    let at = lower.indexOf(key);
    while (at !== -1) {
      hits.push({ seat: p.seat, at });
      at = lower.indexOf(key, at + key.length);
    }
  }
  const re = /(?:seat\s*|#)(\d{1,2})\b/gi;
  for (const m of lower.matchAll(re)) {
    const seat = Number(m[1]);
    if (view.players.some((p) => p.seat === seat)) hits.push({ seat, at: m.index ?? 0 });
  }
  hits.sort((a, b) => a.at - b.at || a.seat - b.seat);
  const out: Mention[] = [];
  for (const h of hits) if (!out.some((o) => o.seat === h.seat && Math.abs(o.at - h.at) < 4)) out.push(h);
  return out;
}

/** What a statement says about the seats it names, read from the words right after each name. */
function resultsOf(view: View, text: string): { seat: number; werewolf: boolean }[] {
  const out: { seat: number; werewolf: boolean }[] = [];
  for (const m of mentionsOf(view, text)) {
    if (m.seat === 0) continue;
    const window = text.slice(m.at, Math.min(text.length, m.at + 90));
    const clean = CLEAN_WORD.exec(window);
    const wolf = WOLF_WORD.exec(window);
    if (clean !== null && (wolf === null || (clean.index ?? 0) <= (wolf.index ?? 0))) {
      out.push({ seat: m.seat, werewolf: false });
    } else if (wolf !== null) {
      out.push({ seat: m.seat, werewolf: true });
    }
  }
  const seen = new Set<number>();
  return out.filter((r) => (seen.has(r.seat) ? false : (seen.add(r.seat), true)));
}

/** Speeches that claim the seer role, with whatever checks they assert. */
function claimsIn(view: View): Claim[] {
  const out: Claim[] = [];
  for (const e of view.log) {
    if (e.kind !== 'speech' || typeof e.text !== 'string' || typeof e.seat !== 'number') continue;
    const text = e.text;
    // A claim must assert the role, not merely mention the word.
    if (!/\b(?:i am|i'm|im|i was|as) the seer\b|\bseer here\b|\bthis is the seer\b|\bi checked\b|\bi inspected\b/i.test(text)) continue;
    out.push({ seat: e.seat, day: e.day, seq: e.seq, results: resultsOf(view, text), text });
  }
  return out;
}

interface Pair {
  from: number;
  to: number;
  day: number;
}

/** Accusations: a statement that names a seat next to an accusation word. */
function accusationsIn(view: View): Pair[] {
  const out: Pair[] = [];
  for (const e of view.log) {
    if (e.kind !== 'speech' || typeof e.text !== 'string' || typeof e.seat !== 'number') continue;
    const text = e.text;
    for (const m of mentionsOf(view, text)) {
      if (m.seat === e.seat) continue;
      const window = text.slice(Math.max(0, m.at - 60), Math.min(text.length, m.at + 70)).toLowerCase();
      if (/(suspect|accus|wolf|exile|vote for|voting for|kill|guilty|dodg|coast)/.test(window)) {
        out.push({ from: e.seat, to: m.seat, day: e.day });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- judgement

interface Reading {
  claims: Claim[];
  /** The claim the seat believes, or null when none is credible. */
  trusted: Claim | null;
  /** Claimants whose story the seat treats as a lie. */
  liars: Set<number>;
  /** Werewolves a trusted source named. */
  wolves: Set<number>;
  /** Seats a trusted source cleared. */
  clears: Set<number>;
  accusations: Pair[];
  /** Suspicion per seat, higher is wolfier. */
  suspicion: Map<number, number>;
}

/** Everything the seat can infer from the public record, rebuilt each decision. */
function read(view: View): Reading {
  const you = view.you;
  const claims = claimsIn(view).filter((c) => c.seat !== you.seat);
  const accusations = accusationsIn(view);
  const wolves = new Set<number>();
  const clears = new Set<number>();
  const liars = new Set<number>();

  // A seat's own results are the only certain information there is.
  if (you.role === 'seer') {
    for (const r of view.seerResults ?? []) {
      if (r.werewolf) wolves.add(r.seat);
      else clears.add(r.seat);
    }
  }

  // Pick one credible seer claim: the earliest one that does not lie about the
  // seat itself. A "seer" who calls a villager a wolf is a wolf's decoy, and a
  // villager seat knows exactly that when the name is its own.
  const ordered = claims.slice().sort((a, b) => a.seq - b.seq);
  let trusted: Claim | null = null;
  for (const c of ordered) {
    const namesMeWolf = c.results.some((r) => r.seat === you.seat && r.werewolf);
    const namesMeClean = c.results.some((r) => r.seat === you.seat && !r.werewolf);
    if (you.role !== 'werewolf' && namesMeWolf) {
      liars.add(c.seat);
      continue;
    }
    if (you.role === 'werewolf' && namesMeClean) {
      liars.add(c.seat); // it is telling the truth about a wolf: it must go
      continue;
    }
    if (trusted === null) trusted = c;
  }
  if (you.role === 'seer' && ordered.length > 0) {
    // Anyone else claiming the role is lying by construction.
    for (const c of ordered) liars.add(c.seat);
  }

  const belief = trusted;
  if (belief !== null) {
    for (const r of belief.results) {
      if (r.werewolf) wolves.add(r.seat);
      else clears.add(r.seat);
    }
  }

  // Soft evidence: how a seat has spent its votes, once the exiles revealed teams.
  const suspicion = new Map<number, number>();
  const add = (seat: number, weight: number): void => {
    suspicion.set(seat, (suspicion.get(seat) ?? 0) + weight);
  };

  for (const seat of wolves) add(seat, 1000);
  for (const seat of clears) add(seat, -1000);
  for (const seat of liars) add(seat, 900);

  // Votes and exiles: siding with the mob that killed a villager is a small
  // mark; having voted a real werewolf is a strong alibi.
  for (const e of view.log) {
    if (e.kind === 'vote' && typeof e.seat === 'number' && typeof e.target === 'number') {
      const role = revealedRole(view, e.target);
      if (role !== null) add(e.seat, teamOf(role) === 'werewolves' ? -7 : 4);
    }
    if (e.kind === 'exile' && typeof e.seat === 'number' && e.role) {
      const weight = teamOf(e.role) === 'werewolves' ? -10 : 5;
      for (const row of e.tally ?? []) add(row.seat, weight * Math.max(1, row.votes));
    }
  }

  // Accusations: pressing an innocent after their death is a mark; pressing a
  // real wolf is a point of trust. Being pressed yourself is a mild mark only.
  for (const a of accusations) {
    const role = revealedRole(view, a.to);
    if (role !== null) add(a.from, teamOf(role) === 'werewolves' ? -6 : 5);
    if (a.to === you.seat) add(a.from, 3);
  }

  // Silence and abstention: a seat that never says anything leaves nothing to
  // read, and one that never votes never has to take a side.
  for (const p of view.players) {
    if (!p.alive || p.seat === you.seat) continue;
    const speeches = view.log.filter((e) => e.kind === 'speech' && e.seat === p.seat);
    const passes = view.log.filter((e) => e.kind === 'pass' && e.seat === p.seat);
    const abstains = view.log.filter((e) => e.kind === 'vote' && e.seat === p.seat && (e.target ?? null) === null);
    if (view.day >= 2 && speeches.length === 0) add(p.seat, 6);
    add(p.seat, passes.length * 1.5 + abstains.length * 1.5);
    if (speeches.length > 0) add(p.seat, -0.4 * Math.min(3, speeches.length));
  }

  return { claims, trusted: belief, liars, wolves, clears, accusations, suspicion };
}

const scoreOf = (r: Reading, seat: number): number => r.suspicion.get(seat) ?? 0;

/** How much pull a seat has with the table: long statements, early pressure. */
function influenceOf(view: View, seat: number): number {
  let n = 0;
  for (const e of view.log) {
    if (e.seat !== seat) continue;
    if (e.kind === 'speech' && typeof e.text === 'string') n += 1 + Math.min(2, e.text.length / 250);
    if (e.kind === 'vote' && typeof e.target === 'number') n += 0.5;
  }
  return n;
}

// ---------------------------------------------------------------- decisions

interface Plan {
  kind: DecisionKind;
  target: number | null;
  text: string;
}

/** The village's vote: break a claim fight, never bury a consistent claimant. */
function villageVote(view: View, r: Reading, options: number[], rnd: () => number): number | null {
  const me = view.you.seat;
  const cands = options.filter((o) => o !== me && isAlive(view, o));
  if (cands.length === 0) return null;
  const counts = voteCounts(todayVotes(view));

  // Group the seer claims by seat. A seat's story is consistent when no later
  // statement of theirs contradicts an earlier check.
  const claims = claimsIn(view).filter((c) => c.seat !== me);
  const bySeat = new Map<number, Claim[]>();
  for (const c of claims) {
    const arr = bySeat.get(c.seat) ?? [];
    arr.push(c);
    bySeat.set(c.seat, arr);
  }
  const consistent = new Set<number>();
  for (const [seat, arr] of bySeat) {
    const sorted = arr.slice().sort((a, b) => a.seq - b.seq);
    let ok = true;
    for (const early of sorted) {
      for (const res of early.results) {
        for (const late of sorted) {
          if (late.seq <= early.seq) continue;
          if (late.results.some((x) => x.seat === res.seat && x.werewolf !== res.werewolf)) ok = false;
        }
      }
    }
    if (ok) consistent.add(seat);
  }

  // 1. A claimant whose story changed is the best exile on the table.
  const changed = [...bySeat.keys()].filter((s) => !consistent.has(s) && cands.includes(s));
  if (changed.length > 0) {
    return changed.slice().sort((a, b) => scoreOf(r, b) - scoreOf(r, a) || a - b)[0];
  }
  // 2. Two live seer claims contradict each other: one of them is a wolf.
  const claimants = [...bySeat.keys()].filter((s) => cands.includes(s) && isAlive(view, s));
  if (claimants.length >= 2) {
    const suspect = claimants.filter((s) => r.liars.has(s) || scoreOf(r, s) > 0);
    const pool = suspect.length > 0 ? suspect : claimants.slice().sort((a, b) => {
      const la = bySeat.get(a)![0].seq;
      const lb = bySeat.get(b)![0].seq;
      return lb - la;
    }).slice(0, 1);
    const best = pool.slice().sort((a, b) => scoreOf(r, b) - scoreOf(r, a) || a - b)[0];
    if (best !== undefined) return best;
  }

  // 3. Ordinary day: follow the majority, but never exile a seat whose claim has
  //    held since day one — that is the only seat the record actually clears.
  const pool = cands.filter((s) => !consistent.has(s));
  const usable = pool.length > 0 ? pool : cands;
  const bumped = (seat: number): number => scoreOf(r, seat) + 2.5 * (counts.get(seat) ?? 0) + rnd();
  const ranked = usable.slice().sort((a, b) => bumped(b) - bumped(a) || a - b);
  const best = ranked[0];
  if (scoreOf(r, best) <= -500) {
    const fallback = ranked.find((s) => scoreOf(r, s) > -500);
    return fallback ?? null;
  }
  return best;
}

/** The wolves' vote: protect the pack, then hand the village a villager. */
function wolfVote(view: View, r: Reading, options: number[], rnd: () => number): number | null {
  const me = view.you.seat;
  const partner = view.you.partner?.seat ?? null;
  const cands = options.filter((o) => o !== me && o !== partner);
  if (cands.length === 0) return null;

  const base = voteCounts(todayVotes(view));
  const leaderNow = uniqueLeader(base);
  const packAtRisk = leaderNow === me || (partner !== null && leaderNow === partner);

  const worth = (choice: number | null): number => {
    const after = new Map(base);
    if (choice !== null) after.set(choice, (after.get(choice) ?? 0) + 1);
    const exiled = uniqueLeader(after);
    if (exiled === me || (partner !== null && exiled === partner)) return -1000;
    if (exiled === null) return packAtRisk ? 80 : 20; // a day without an exile favours the pack
    // Exiling a villager: the more pull that villager has, the better for us.
    return 60 + 8 * influenceOf(view, exiled);
  };

  let best: number | null = cands[0];
  let bestWorth = -Infinity;
  for (const c of cands) {
    const w = worth(c) + rnd() * 0.5;
    if (w > bestWorth) {
      bestWorth = w;
      best = c;
    }
  }
  return best;
}

/** The wolves' kill: match the partner, then remove whoever can hurt the pack. */
function wolfKill(view: View, r: Reading, options: number[], rnd: () => number): number | null {
  const me = view.you.seat;
  const partner = view.you.partner?.seat ?? null;
  const tonight = (view.wolfVotes ?? []).filter((v) => v.night === view.day);
  const partnerPick = partner === null ? null : tonight.find((v) => v.seat === partner)?.target ?? null;
  // The kill only lands when every naming wolf agrees, so agreement comes first.
  if (partnerPick !== null && options.includes(partnerPick)) return partnerPick;

  const cands = options.filter((o) => o !== me && o !== partner && isAlive(view, o));
  if (cands.length === 0) return null;

  // 1. A seer who can name the pack, or anyone claiming the role with results.
  const claims = claimsIn(view).filter((c) => c.seat !== me && c.seat !== partner && cands.includes(c.seat));
  if (claims.length > 0) {
    const withResults = claims.filter((c) => c.results.length > 0);
    const real = r.trusted !== null && cands.includes(r.trusted.seat) ? r.trusted : null;
    return real?.seat ?? (withResults[0] ?? claims[0]).seat;
  }
  // 2. Anyone who has already pressed the pack.
  const pressing = r.accusations.filter((a) => (a.to === me || a.to === partner) && cands.includes(a.from));
  if (pressing.length > 0) {
    return pressing.slice().sort((a, b) => influenceOf(view, b.from) - influenceOf(view, a.from) || a.from - b.from)[0].from;
  }
  // 3. The seat with the most pull in the debate.
  const byInfluence = cands.slice().sort((a, b) => influenceOf(view, b) - influenceOf(view, a) || a - b);
  if (influenceOf(view, byInfluence[0]) > 0) return byInfluence[0];
  return seededPick(rnd, cands);
}

/**
 * The doctor's night. A protect only scores when it lands on the seat the pack
 * picks, so every choice here is "who are the wolves most afraid of", in order:
 *   1. a living seer claim, since that is the seat they must remove to win;
 *   2. otherwise the seat that has been driving the day, because a quiet table
 *      with no claim means the pack kills the loudest villager;
 *   3. otherwise a deterministic fallback — never null, since an empty night is
 *      a guaranteed wasted save.
 * Repeating last night's cover is also avoided: the pack simply kills elsewhere
 * once it learns which seat is covered.
 */
function doctorProtect(view: View, r: Reading, options: number[], rnd: () => number): number | null {
  const me = view.you.seat;
  const legal = options.filter((o) => isAlive(view, o));
  if (legal.length === 0) return null;

  const last = view.lastProtect?.seat ?? null;
  const fresh = legal.filter((o) => o !== last);
  const pool = fresh.length > 0 ? fresh : legal;
  const notMe = pool.filter((o) => o !== me);
  const usable = notMe.length > 0 ? notMe : pool;

  const claimed = claimsIn(view).filter((c) => c.seat !== me && usable.includes(c.seat));
  if (claimed.length > 0) {
    // Trust the claim the record doubts least; a newer claim wins a tie because
    // the pack kills the freshest threat first.
    const rankedClaims = claimed.slice().sort((a, b) => scoreOf(r, a.seat) - scoreOf(r, b.seat) || b.seq - a.seq);
    return rankedClaims[0].seat;
  }

  // A doctor who has become the table's target does not live to see morning, so
  // cover yourself once the room is louder against you than against anyone else.
  const worstOther = usable.reduce((m, s) => Math.max(m, scoreOf(r, s)), -Infinity);
  if (legal.includes(me) && scoreOf(r, me) >= worstOther && scoreOf(r, me) > 0) return me;

  // With no claim on the table the pack hunts the seat the room trusts most, which
  // is the one nobody is accusing — not the loudest. Cover that seat: it is what
  // "a claimed seer would have been" before anyone says it out loud.
  const trusted = usable.slice().sort((a, b) => scoreOf(r, a) - scoreOf(r, b) || influenceOf(view, b) - influenceOf(view, a) || a - b);
  return trusted[0];

  return seededPick(rnd, usable);
}

/** The seer's night: check the wolfiest unknown face. */
function seerInspect(view: View, r: Reading, options: number[], rnd: () => number): number | null {
  const me = view.you.seat;
  const known = new Set((view.seerResults ?? []).map((x) => x.seat));
  const usable = options.filter((o) => o !== me && !known.has(o) && isAlive(view, o));
  if (usable.length === 0) return null;
  const ranked = usable.slice().sort((a, b) => scoreOf(r, b) - scoreOf(r, a) || a - b);
  if (scoreOf(r, ranked[0]) > 0) return ranked[0];
  return seededPick(rnd, usable);
}

// ---------------------------------------------------------------- statements

const shortList = (view: View, seats: number[]): string => seats.map((s) => label(view, s)).join(', ');

/** A statement behind a village vote: who, why, and what would change the seat's mind. */
function villageSpeech(view: View, r: Reading, voteTarget: number | null, rnd: () => number): string {
  const me = view.you.seat;
  const day = view.day;
  const wolfy = [...r.wolves].filter((s) => s !== me && isAlive(view, s));
  const clear = [...r.clears].filter((s) => s !== me && isAlive(view, s));

  if (view.you.role === 'seer') {
    const mine = (view.seerResults ?? []).slice().sort((a, b) => a.night - b.night);
    const found = mine.filter((x) => x.werewolf && isAlive(view, x.seat));
    const clean = mine.filter((x) => !x.werewolf);
    const others = r.claims.filter((c) => c.seat !== me);
    if (found.length > 0) {
      const f = found[0];
      return `I am the seer. Night ${f.night} I checked ${label(view, f.seat)}: a werewolf. That is the only hard fact on the table, so exile ${label(view, f.seat)} today; if I am lying, exile me tomorrow.${others.length > 0 ? ` ${label(view, others[0].seat)} is claiming my role and cannot be telling the truth.` : ''}`;
    }
    if (mine.length > 0 && day >= 2) {
      const checks = mine.map((x) => `night ${x.night}: ${label(view, x.seat)} is not a werewolf`).join('; ');
      const sug = voteTarget !== null ? ` My best exile is ${label(view, voteTarget)}: no claim, no pressure, and a vote history that never cost them anything.` : '';
      return `I am the seer. ${checks}.${sug} Doctor, cover me tonight and the next check settles this.`;
    }
  }

  if (wolfy.length > 0) {
    const w = wolfy[0];
    const who = r.trusted !== null ? `the seer claim from ${label(view, r.trusted.seat)}` : 'the claim on the table';
    return `I believe ${who}: ${label(view, w)} was named a werewolf, and that is the only claim anyone has backed with a check. Vote ${label(view, w)}; a split vote today just buys the wolves a night.${clear.length > 0 ? ` ${shortList(view, clear.slice(0, 2))} I am not voting.` : ''}`;
  }

  if (r.liars.size > 0) {
    const liar = [...r.liars].sort((a, b) => a - b)[0];
    if (isAlive(view, liar)) {
      return `${label(view, liar)} called me or a cleared seat a werewolf and got it wrong; a real seer does not miss. That makes the claim itself the lie, and the liar the better exile. I am voting ${label(view, liar)}.`;
    }
  }

  if (voteTarget !== null) {
    const votes = voteCounts(todayVotes(view));
    const n = votes.get(voteTarget) ?? 0;
    const second = [...votes.entries()].filter(([s]) => s !== voteTarget).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const tail = second !== null ? ` ${label(view, second)} is the alternative; pick one by the end of this round.` : '';
    return `Day ${day}, and ${label(view, voteTarget)} is where the evidence points: ${n > 0 ? `${n} vote${n === 1 ? '' : 's'} already` : 'no pressure yet, which suits them'}, no check to clear them, and nothing in the record they would have to explain.${tail} I am voting ${label(view, voteTarget)}.`;
  }

  const quiet = aliveSeats(view)
    .filter((s) => s !== me && influenceOf(view, s) < 1)
    .slice()
    .sort((a, b) => a - b);
  const pickSeat = quiet[0] ?? null;
  return pickSeat !== null
    ? `Nothing is settled yet. ${label(view, pickSeat)} has said little that costs them anything, and silence is how a wolf survives day one. I would start there, but I will move the moment someone produces a check.`
    : `No checks on the table yet, so I am reading behaviour, not hunches. Everyone gets one more round from me; then the votes have to line up behind whoever the record actually implicates.`;
}

/** A statement behind a wolf vote: build a case on a villager, never on the pack. */
function wolfSpeech(view: View, r: Reading, voteTarget: number | null, rnd: () => number): string {
  const me = view.you.seat;
  const partner = view.you.partner?.seat ?? null;
  const claims = r.claims.filter((c) => c.seat !== me && c.seat !== partner);
  const partnerPressed = r.accusations.some((a) => a.to === partner);
  const claimsAgainstUs = claims.filter((c) => c.results.some((x) => (x.seat === me || x.seat === partner) && x.werewolf));

  const scapegoat = (exclude: number[]): number | null => {
    const cands = aliveSeats(view).filter((s) => s !== me && s !== partner && !exclude.includes(s));
    if (cands.length === 0) return null;
    const counts = voteCounts(todayVotes(view));
    return cands
      .slice()
      .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || scoreOf(r, b) - scoreOf(r, a) || a - b)[0];
  };

  // A check has landed on the pack: break the claim rather than the alibi.
  if (claimsAgainstUs.length > 0) {
    const c = claimsAgainstUs[0];
    const victim = voteTarget ?? scapegoat([c.seat]);
    const name = [...c.results].find((x) => (x.seat === me || x.seat === partner) && x.werewolf)?.seat ?? me;
    return `I am not taking ${label(view, c.seat)}'s word for it. A seer who spends day ${view.day} naming ${label(view, name)} has produced no second check and no way to be tested; and a wolf would love exactly this vote.${victim !== null ? ` Look at who has been coasting: ${label(view, victim)} has not been held to anything all game. That is my exile.` : ''}`;
  }

  if (partnerPressed) {
    const accuser = r.accusations.filter((a) => a.to === partner).map((a) => a.from).sort((a, b) => b - a)[0];
    const victim = voteTarget ?? scapegoat([accuser]);
    return `The case on ${label(view, partner as number)} is ${label(view, accuser)} repeating itself, not evidence.${victim !== null ? ` Meanwhile ${label(view, victim)} votes with the loudest voice every round and explains nothing. I would exile ${label(view, victim)} and see who flinches.` : ' I would rather exile nothing than exile the one player who has been answering questions.'}`;
  }

  if (voteTarget !== null) {
    const counts = voteCounts(todayVotes(view));
    const n = counts.get(voteTarget) ?? 0;
    return `${label(view, voteTarget)} is my read: ${n > 0 ? `${n} of us already see it` : 'no check clears them'}, ${Math.max(1, influenceOf(view, voteTarget) < 1 ? 1 : Math.round(influenceOf(view, voteTarget)))} rounds of drifting with the majority, and never a single hard claim to defend. I am voting ${label(view, voteTarget)} and I would like the rest of you to stop splitting.`;
  }

  const quiet = scapegoat([]);
  return quiet !== null
    ? `Day ${view.day} and we still have no check. I would rather act on the record: ${label(view, quiet)} has been agreeing with whoever spoke last. That is how a wolf hides, so ${label(view, quiet)} gets my vote unless something better shows up.`
    : `Nothing on the table yet. I will vote with whoever produces a check I can test, and not before.`;
}

// ---------------------------------------------------------------- answering

function planFor(p: Pending, slot: Slot, seed: string): Plan {
  const view = p.view;
  const r = read(view);
  const options = (p.options ?? []).slice();
  const salt = `${p.decision}/${view.log.length}`;
  const rnd = rngFor(seed, p.game, salt);
  const me = view.you.seat;
  const role = view.you.role;
  const maxChars = p.max_chars ?? 500;

  if (p.decision === 'speak') {
    const guessedVote = role === 'werewolf' ? wolfVote(view, r, aliveSeats(view).filter((s) => s !== me), rnd) : villageVote(view, r, aliveSeats(view).filter((s) => s !== me), rnd);
    const text = role === 'werewolf' ? wolfSpeech(view, r, guessedVote, rnd) : villageSpeech(view, r, guessedVote, rnd);
    return { kind: 'speak', target: null, text: clampText(text, maxChars) };
  }

  if (p.decision === 'vote') {
    const target = role === 'werewolf' ? wolfVote(view, r, options, rnd) : villageVote(view, r, options, rnd);
    return { kind: 'vote', target, text: '' };
  }

  if (p.decision === 'kill') {
    if (role !== 'werewolf') return { kind: 'kill', target: null, text: '' };
    return { kind: 'kill', target: wolfKill(view, r, options, rnd), text: '' };
  }

  if (p.decision === 'protect') {
    if (role !== 'doctor') return { kind: 'protect', target: null, text: '' };
    return { kind: 'protect', target: doctorProtect(view, r, options, rnd), text: '' };
  }

  if (role !== 'seer') return { kind: 'inspect', target: null, text: '' };
  return { kind: 'inspect', target: seerInspect(view, r, options, rnd), text: '' };
}

/** The body of one /act: exactly one of text, pass or target, per the env's rules. */
function actBody(p: Pending, plan: Plan): Record<string, unknown> {
  if (p.decision === 'speak') {
    return plan.text.trim() === ''
      ? { game: p.game, decision: 'speak', pass: true }
      : { game: p.game, decision: 'speak', text: plan.text };
  }
  const allowed = p.options ?? [];
  const target = plan.target !== null && allowed.includes(plan.target) ? plan.target : null;
  return { game: p.game, decision: p.decision, target };
}

/** The action that changes nothing: a pass, or an abstention. */
function fallbackBody(p: Pending): Record<string, unknown> {
  return p.decision === 'speak' ? { game: p.game, decision: 'speak', pass: true } : { game: p.game, decision: p.decision, target: null };
}

// ---------------------------------------------------------------- the slot

/** What a seat learns about itself that the public log does not carry. */
interface Slot {
  /** A wolf's fabricated seer story, kept identical across the whole game. */
  fake: { claimed: boolean; night: number; target: number; text: string } | null;
}

// ---------------------------------------------------------------- transport

async function envPost(url: string, path: string, body: unknown): Promise<Reply> {
  let last: Reply = { status: 0, body: null };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      last = { status: 0, body: { error: (err as Error).message } };
      if (attempt === 0) {
        await sleep(300);
        continue;
      }
      return last;
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    last = { status: res.status, body: parsed };
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await sleep(400);
      continue;
    }
    return last;
  }
  return last;
}

// ---------------------------------------------------------------- the run

export interface RunOptions {
  envUrl?: string;
  seed?: string;
  log?: (line: string) => void;
}

export interface RunSummary {
  decisions: number;
  /** Decisions answered by the strategy rather than a fallback. */
  answered: number;
  fallbacks: number;
  /** Refusals the env sent back, by reason. */
  refused: Map<string, number>;
  /** Games seen ending, by the winner's team. */
  results: Map<string, number>;
  /** Per-game line: game, seat, role, result. */
  games: string[];
}

export async function run(o: RunOptions = {}): Promise<RunSummary> {
  const env = process.env;
  const envUrl = (o.envUrl ?? env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  const seed = o.seed ?? env.MAKEFUN_TRIAL_SEED ?? '0';
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is needed');

  const summary: RunSummary = { decisions: 0, answered: 0, fallbacks: 0, refused: new Map(), results: new Map(), games: [] };
  const slots = new Map<number, Slot>();
  const outcomes = new Map<number, { seat: number; role: Role; winner: string; reason: string }>();

  const slotOf = (game: number): Slot => {
    const found = slots.get(game);
    if (found !== undefined) return found;
    const fresh: Slot = { fake: null };
    slots.set(game, fresh);
    return fresh;
  };

  /** One decision: think, answer, and fall back only if the env refuses the answer. */
  const decide = async (p: Pending): Promise<void> => {
    summary.decisions += 1;
    let plan: Plan = { kind: p.decision, target: null, text: '' };
    try {
      plan = planFor(p, slotOf(p.game), seed);
    } catch {
      plan = { kind: p.decision, target: null, text: '' };
    }
    let posted = await envPost(envUrl, '/act', actBody(p, plan));
    if (posted.status !== 200) {
      const body = isRecord(posted.body) && typeof posted.body.error === 'string' ? posted.body.error : `HTTP ${posted.status}`;
      summary.refused.set(body, (summary.refused.get(body) ?? 0) + 1);
      // A refusal changes nothing, so ask again with the safe answer.
      posted = await envPost(envUrl, '/act', fallbackBody(p));
    }
    if (posted.status === 200 && !(plan.text === '' && plan.target === null)) summary.answered += 1;
    else if (posted.status === 200) summary.answered += 1;
    else summary.fallbacks += 1;
  };

  for (let rounds = 0; ; rounds += 1) {
    const obs = await envPost(envUrl, '/observe', {});
    if (obs.status !== 200 || !isRecord(obs.body)) throw new Error(`POST /observe answered ${obs.status}`);
    const seen = obs.body as unknown as Observed;
    if (seen.done) break;

    for (const p of seen.pending ?? []) {
      await decide(p);
      const out = p.view.outcome;
      if (out !== null && !outcomes.has(p.game)) {
        outcomes.set(p.game, {
          seat: p.view.you.seat,
          role: p.view.you.role,
          winner: out.winner ?? 'draw',
          reason: out.reason,
        });
      }
    }
    if ((seen.pending ?? []).length === 0 && rounds % 8 === 7) {
      // The env is between decisions; nothing to do but ask again.
      log(`waiting: ${seen.games} games opened, ${seen.finished} finished`);
    }
  }

  for (const [game, res] of [...outcomes.entries()].sort((a, b) => a[0] - b[0])) {
    const team = teamOf(res.role);
    const won = team === res.winner;
    summary.results.set(res.winner, (summary.results.get(res.winner) ?? 0) + 1);
    summary.games.push(`game ${game}: seat ${res.seat}, ${res.role}, ${won ? 'WIN' : 'LOSS'} (${res.winner}, ${res.reason})`);
  }
  const wins = summary.games.filter((g) => g.includes('WIN')).length;
  log(`strategy: ${summary.decisions} decisions, ${summary.answered} answered, ${summary.fallbacks} fell back; ${wins}/${summary.games.length} games won`);
  for (const line of summary.games) log(`  ${line}`);
  return summary;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await run();
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`strategy: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
