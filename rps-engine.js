/**
 * rps-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * מנוע החישוב המשותף של Rock-Paper-Scissors
 * כל פונקציית חישוב נמצאת כאן בלבד — גם המחשב החכם וגם הרמאות
 * טוענים מקובץ זה ומקבלים תמיד אותה תוצאה.
 *
 * שימוש (browser):
 *   <script src="rps-engine.js"></script>
 *   const profile = RPSEngine.buildProfile(allGames, playerName, mode);
 *   const rec     = RPSEngine.buildRecommendation(profile, ctx);
 *
 * שימוש (Node / module):
 *   const RPSEngine = require('./rps-engine');
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();          // CommonJS / Node
  } else {
    root.RPSEngine = factory();          // Browser global
  }
}(typeof self !== 'undefined' ? self : this, function () {

  'use strict';

  // ══════════════════════════════════════════════════════════════════════════
  // CONSTANTS
  // ══════════════════════════════════════════════════════════════════════════

  const CHOICES   = ['rock', 'paper', 'scissors'];
  const EMOJI     = { rock: '✊', paper: '📄', scissors: '✂️' };
  const HEB       = { rock: 'אבן', paper: 'נייר', scissors: 'מספריים' };

  /** מה מנצח את מה: BEATS[X] = Y  ⇒  Y מנצח X */
  const BEATS     = { rock: 'paper',    paper: 'scissors', scissors: 'rock' };

  /** מה מפסיד ל: BEATEN_BY[X] = Y  ⇒  Y מפסיד ל-X */
  const BEATEN_BY = { rock: 'scissors', paper: 'rock',     scissors: 'paper' };

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * ממיר hex color → 'warm' | 'cool' | 'neutral'
   * @param {string|undefined} hex  e.g. "#ff6b6b"
   * @returns {'warm'|'cool'|'neutral'|'unknown'}
   */
  function hexToHueBucket(hex) {
    if (!hex) return 'unknown';
    try {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (!d) return 'neutral';
      let h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6
            : max === g ? ((b - r) / d + 2) / 6
                        : ((r - g) / d + 4) / 6;
      h = Math.round(h * 360);
      return (h < 60 || h > 300) ? 'warm' : 'cool';
    } catch (e) { return 'unknown'; }
  }

  /**
   * דעיכת זיכרון אקספוננציאלית
   * @param {number} elapsedMs   זמן שעבר במילישניות
   * @param {number} halfLifeMs  זמן חצי-חיים
   * @returns {number} 0–1
   */
  function computeDecay(elapsedMs, halfLifeMs) {
    if (!elapsedMs || elapsedMs <= 0) return 1;
    return Math.pow(0.5, elapsedMs / halfLifeMs);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DATA PREPARATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * בונה רשימת "בחירות גלובליות" עם ניצול הוגן לפי שחקן.
   * @param {object[]} allGames  כל רשומות ה-games מ-Firebase
   * @returns {object[]}
   */
  function buildGlobalGames(allGames) {
    const perPlayer = {};
    allGames.forEach(g => {
      if (g.p1 && g.p1Choice) perPlayer[g.p1] = (perPlayer[g.p1] || 0) + 1;
      if (g.p2 && g.p2Choice) perPlayer[g.p2] = (perPlayer[g.p2] || 0) + 1;
    });
    const uniquePlayers = Object.keys(perPlayer).length;
    const totalRaw      = Object.values(perPlayer).reduce((s, n) => s + n, 0) || 1;

    const MAX_PLAYER_SHARE = uniquePlayers <= 2  ? 0.50
                           : uniquePlayers <= 5  ? 0.30
                           : uniquePlayers <= 10 ? 0.25
                                                 : 0.20;

    const playerWeight = {};
    Object.entries(perPlayer).forEach(([p, n]) => {
      const share = n / totalRaw;
      playerWeight[p] = share > MAX_PLAYER_SHARE ? MAX_PLAYER_SHARE / share : 1.0;
    });

    const out = [];
    allGames.forEach(g => {
      if (g.p1Choice) out.push({
        playerChoice: g.p1Choice, playerPos: g.p1ChoicePosition,
        playerColors: g.colors,   timestamp:  g.timestamp,
        prevOutcome:  g.p1PrevOutcome, mode: g.mode,
        _playerW: playerWeight[g.p1] ?? 1
      });
      if (g.p2Choice) out.push({
        playerChoice: g.p2Choice, playerPos: g.p2ChoicePosition,
        playerColors: g.colors,   timestamp:  g.timestamp,
        prevOutcome:  g.p2PrevOutcome, mode: g.mode,
        _playerW: playerWeight[g.p2] ?? 1
      });
    });
    return out;
  }

  /**
   * מחשב half-life של recency לפי drift בין ה-quarter הוותיק לחדש.
   * @param {object[]} games
   * @returns {number} ms
   */
  function computeRecencyHalfLife(games) {
    const DAY     = 24 * 60 * 60 * 1000;
    const DEFAULT = 30 * DAY;
    const sorted  = games
      .filter(g => g.timestamp && CHOICES.includes(g.playerChoice))
      .sort((a, b) => a.timestamp - b.timestamp);
    if (sorted.length < 10) return DEFAULT;

    const q      = Math.max(Math.floor(sorted.length / 4), 3);
    const oldest = sorted.slice(0, q);
    const newest = sorted.slice(-q);
    const dist   = seg => {
      const t = seg.length;
      const d = {};
      CHOICES.forEach(c => d[c] = seg.filter(g => g.playerChoice === c).length / t);
      return d;
    };
    const od    = dist(oldest), nd = dist(newest);
    const drift = CHOICES.reduce((s, c) => s + Math.abs(od[c] - nd[c]), 0) / 3;

    if (drift < 0.05) return 60 * DAY;
    if (drift < 0.10) return DEFAULT;
    if (drift < 0.18) return 15 * DAY;
    return 7 * DAY;
  }

  /**
   * מוסיף משקל .w לכל משחק לפי recency + mode matching + player cap.
   * @param {object[]} games
   * @param {number}   recencyHalfLife
   * @param {'app'|'physical'|null} activeMode
   * @returns {object[]}
   */
  function addRecencyWeights(games, recencyHalfLife, activeMode) {
    const now         = Date.now();
    const modeMatch   = activeMode === 'app'     ? 'online' : 'local';
    const modeMismatch= activeMode === 'app'     ? 'local'  : 'online';
    return games.map(g => {
      const recency  = g.timestamp
        ? Math.max(computeDecay(now - g.timestamp, recencyHalfLife), 0.05)
        : 0.5;
      const modeMult = activeMode
        ? (g.mode === modeMatch ? 2.0 : g.mode === modeMismatch ? 0.5 : 1.0)
        : 1.0;
      const playerMult = g._playerW ?? 1;
      return { ...g, w: recency * modeMult * playerMult };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * מחשב סטטיסטיקות בסיס (אחוזי בחירה, פירוט לפי מיקום וצבע).
   * @param {object[]} games  משחקים עם .w
   * @returns {{ counts, pcts, total, posCounts, colorCounts }}
   */
  function computeStats(games) {
    const counts     = { rock: 0, paper: 0, scissors: 0 };
    const posCounts  = { rock: {}, paper: {}, scissors: {} };
    const colorCounts= { rock: {}, paper: {}, scissors: {} };

    games.forEach(g => {
      const c = g.playerChoice;
      if (counts[c] === undefined) return;
      const w   = g.w ?? 1;
      counts[c] += w;
      const pos = g.playerPos || 'unknown';
      posCounts[c][pos] = (posCounts[c][pos] || 0) + w;
      if (g.playerColors) {
        const b = hexToHueBucket(g.playerColors[c]);
        colorCounts[c][b] = (colorCounts[c][b] || 0) + w;
      }
    });

    const total = counts.rock + counts.paper + counts.scissors;
    const pcts  = {};
    CHOICES.forEach(c => pcts[c] = total > 0 ? counts[c] / total : 1 / 3);
    return { counts, pcts, total, posCounts, colorCounts };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SIGNAL COMPUTATIONS
  // ══════════════════════════════════════════════════════════════════════════

  /** מודד כמה המיקום (שמאל/אמצע/ימין) משפיע על הבחירה */
  function measurePositionInfluence(games) {
    const wSum  = g => g.w ?? 1;
    const total = games.reduce((s, g) => s + wSum(g), 0) || 1;
    const base  = {};
    CHOICES.forEach(c => base[c] = games.reduce((s, g) => s + (g.playerChoice === c ? wSum(g) : 0), 0) / total);
    let totalDev = 0, count = 0;
    ['left', 'center', 'right'].forEach(pos => {
      const pg  = games.filter(g => g.playerPos === pos);
      const pgW = pg.reduce((s, g) => s + wSum(g), 0);
      if (pgW < 2) return;
      CHOICES.forEach(c => {
        totalDev += Math.abs(pg.reduce((s, g) => s + (g.playerChoice === c ? wSum(g) : 0), 0) / pgW - base[c]);
        count++;
      });
    });
    return count > 0 ? totalDev / count : 0;
  }

  /** מודד כמה הצבע משפיע על הבחירה */
  function measureColorInfluence(games) {
    const gwc  = games.filter(g => g.playerColors && g.playerChoice);
    const wSum = g => g.w ?? 1;
    const total= gwc.reduce((s, g) => s + wSum(g), 0);
    if (total < 4) return 0;
    const base = {};
    CHOICES.forEach(c => base[c] = gwc.reduce((s, g) => s + (g.playerChoice === c ? wSum(g) : 0), 0) / total);
    let totalDev = 0, bCount = 0;
    ['warm', 'cool', 'neutral'].forEach(bucket => {
      const bg  = gwc.filter(g => hexToHueBucket(g.playerColors?.[g.playerChoice]) === bucket);
      const bgW = bg.reduce((s, g) => s + wSum(g), 0);
      if (bgW < 2) return;
      CHOICES.forEach(c => {
        totalDev += Math.abs(bg.reduce((s, g) => s + (g.playerChoice === c ? wSum(g) : 0), 0) / bgW - base[c]);
        bCount++;
      });
    });
    return bCount > 0 ? totalDev / bCount : 0;
  }

  /**
   * מחשב את משקלי ההשפעה של מיקום וצבע.
   * @param {object[]} games        נתוני השחקן (או גלובלי)
   * @param {object[]} globalGames  נתונים גלובלים לבלנד
   * @returns {{ posWeight: number, colorWeight: number }}
   */
  function computeInfluence(games, globalGames) {
    const hasPersonal        = games !== globalGames;
    const posInfluenceScore  = measurePositionInfluence(games);
    const globalPosInfluence = measurePositionInfluence(globalGames);
    const posWeight          = Math.min(
      hasPersonal ? 0.5 * posInfluenceScore + 0.5 * globalPosInfluence : globalPosInfluence, 0.25
    );
    const colorInfluenceScore  = measureColorInfluence(games);
    const globalColorInfluence = measureColorInfluence(globalGames);
    const colorWeight          = Math.min(
      hasPersonal ? 0.5 * colorInfluenceScore + 0.5 * globalColorInfluence : globalColorInfluence, 0.20
    );
    return { posWeight, colorWeight };
  }

  /**
   * Win-Stay / Lose-Shift — מחשב את שיעורי החזרה/שינוי מהנתונים.
   */
  function computeWinStayLoseShiftWeights(games) {
    let wsHits = 0, wsTotal = 0, lsHits = 0, lsTotal = 0;
    const sorted = games
      .filter(g => g.timestamp && g.playerChoice)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (let i = 1; i < sorted.length; i++) {
      const g    = sorted[i];
      const prev = sorted[i - 1];
      if (!prev.playerChoice) continue;
      const w = g.w ?? 1;
      if (g.prevOutcome === 'win') {
        wsTotal += w;
        if (g.playerChoice === prev.playerChoice) wsHits += w;
      } else if (g.prevOutcome === 'loss') {
        lsTotal += w;
        if (g.playerChoice === BEATEN_BY[BEATEN_BY[prev.playerChoice]]) lsHits += w;
      }
    }

    const wsRate   = wsTotal >= 2 ? wsHits / wsTotal : 0.4;
    const lsRate   = lsTotal >= 2 ? lsHits / lsTotal : 0.33;
    const wsWeight = Math.min(Math.max((wsRate - 1 / 3) * 1.5, 0), 0.30);
    const lsWeight = Math.min(Math.max((lsRate - 1 / 3) * 1.5, 0), 0.30);
    return { wsRate, lsRate, wsWeight, lsWeight, wsTotal, lsTotal };
  }

  /**
   * half-life מבוסס-נתונים: כמה מהר win-stay/lose-shift מדעיך?
   */
  function computeHalfLifeFromData(games) {
    const DEFAULT_HALF_LIFE = 10 * 60 * 1000;
    const sortedGames = games
      .filter(g => g.timestamp && g.prevOutcome && g.playerChoice)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (sortedGames.length < 6) return DEFAULT_HALF_LIFE;

    const buckets = [
      { maxMs: 2 * 60 * 1000,  hits: 0, total: 0 },
      { maxMs: 5 * 60 * 1000,  hits: 0, total: 0 },
      { maxMs: 10 * 60 * 1000, hits: 0, total: 0 },
      { maxMs: 20 * 60 * 1000, hits: 0, total: 0 },
      { maxMs: Infinity,        hits: 0, total: 0 },
    ];

    for (let i = 1; i < sortedGames.length; i++) {
      const g       = sortedGames[i];
      const prev    = sortedGames[i - 1];
      const elapsed = g.timestamp - prev.timestamp;
      const outcome = g.prevOutcome;
      if (!outcome) continue;
      let predicted;
      if      (outcome === 'win')  predicted = prev.playerChoice;
      else if (outcome === 'loss') predicted = BEATEN_BY[prev.playerChoice];
      else continue;
      const correct = predicted === g.playerChoice;
      for (const b of buckets) {
        if (elapsed <= b.maxMs) { b.total++; if (correct) b.hits++; break; }
      }
    }

    const rates    = buckets.map(b => b.total >= 2 ? b.hits / b.total : null);
    const peakRate = Math.max(...rates.filter(r => r !== null));
    if (!peakRate) return DEFAULT_HALF_LIFE;
    const thresholds = [2, 5, 10, 20, 60].map(m => m * 60 * 1000);
    for (let i = 0; i < rates.length; i++) {
      if (rates[i] !== null && rates[i] < peakRate * 0.6)
        return thresholds[i - 1] || DEFAULT_HALF_LIFE;
    }
    return DEFAULT_HALF_LIFE;
  }

  /** Transition bias: לאחר (בחירה × תוצאה), מה הסיכוי לכל בחירה? */
  function computeTransitionBias(games) {
    const outcomes = ['win', 'loss', 'tie'];
    const trans    = {};
    CHOICES.forEach(prev => {
      trans[prev] = {};
      outcomes.forEach(out => { trans[prev][out] = { rock: 0, paper: 0, scissors: 0, total: 0 }; });
    });

    const sorted = games
      .filter(g => g.timestamp && CHOICES.includes(g.playerChoice))
      .sort((a, b) => a.timestamp - b.timestamp);

    for (let i = 1; i < sorted.length; i++) {
      const g    = sorted[i];
      const prev = sorted[i - 1];
      if (!CHOICES.includes(prev.playerChoice)) continue;
      const out = g.prevOutcome;
      if (!outcomes.includes(out)) continue;
      const w = g.w ?? 1;
      trans[prev.playerChoice][out][g.playerChoice] += w;
      trans[prev.playerChoice][out].total           += w;
    }

    const probs = {};
    CHOICES.forEach(prev => {
      probs[prev] = {};
      outcomes.forEach(out => {
        const t = trans[prev][out];
        probs[prev][out] = t.total >= 3 ? {
          rock: t.rock / t.total, paper: t.paper / t.total, scissors: t.scissors / t.total, total: t.total
        } : null;
      });
    });

    const overallBase = { rock: 0, paper: 0, scissors: 0 };
    let tot = 0;
    sorted.forEach(g => { const w = g.w ?? 1; overallBase[g.playerChoice] += w; tot += w; });
    if (tot > 0) CHOICES.forEach(c => overallBase[c] /= tot);

    let totalDev = 0, cnt = 0;
    CHOICES.forEach(prev => outcomes.forEach(out => {
      const p = probs[prev][out];
      if (!p) return;
      CHOICES.forEach(c => { totalDev += Math.abs(p[c] - overallBase[c]); cnt++; });
    }));

    const weight = cnt >= 3 ? Math.min((totalDev / cnt) * 2.0, 0.35) : 0;
    return { probs, weight };
  }

  /** Post-tie bias: מה בוחרים אחרי תיקו? */
  function computePostTieBias(games) {
    const counts = { rock: 0, paper: 0, scissors: 0, total: 0 };
    const sorted = games
      .filter(g => g.timestamp && CHOICES.includes(g.playerChoice))
      .sort((a, b) => a.timestamp - b.timestamp);

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].prevOutcome === 'tie') {
        const w = sorted[i].w ?? 1;
        counts[sorted[i].playerChoice] += w;
        counts.total += w;
      }
    }

    if (counts.total < 3) return { probs: null, weight: 0 };
    const probs = {};
    let totalDev = 0;
    CHOICES.forEach(c => { probs[c] = counts[c] / counts.total; totalDev += Math.abs(probs[c] - 1 / 3); });
    return { probs, weight: Math.min(totalDev * 1.8, 0.30), total: counts.total };
  }

  /** Opening bias: שחקנים חדשים נוטים לאבן */
  function computeOpeningBias(personalCount, globalGames) {
    const validGames = globalGames.filter(g => CHOICES.includes(g.playerChoice));
    const total      = validGames.length;
    if (total < 20) return { rockBias: 0, weight: 0, cutoff: 10 };

    const rockRate = validGames.filter(g => g.playerChoice === 'rock').length / total;
    const rockBias = Math.max(rockRate - 1 / 3, 0);
    const cutoff   = 10;
    if (personalCount >= cutoff) return { rockBias, weight: 0, cutoff };
    const weight = Math.min(rockBias * 2.5 * (1 - personalCount / cutoff), 0.25);
    return { rockBias, weight, cutoff, personalCount };
  }

  /** Streak avoidance: שחקנים נדירים חוזרים על אותה בחירה 3+ פעמים */
  function computeStreakAvoidance(games) {
    const sorted = games
      .filter(g => g.timestamp && CHOICES.includes(g.playerChoice))
      .sort((a, b) => a.timestamp - b.timestamp);

    let opportunities = 0, repeats = 0;
    for (let i = 2; i < sorted.length; i++) {
      if (sorted[i - 1].playerChoice === sorted[i - 2].playerChoice) {
        const w = sorted[i].w ?? 1;
        opportunities += w;
        if (sorted[i].playerChoice === sorted[i - 1].playerChoice) repeats += w;
      }
    }

    if (opportunities < 3) return { repeatRate: 0.12, avoidWeight: 0.25 };
    const repeatRate  = repeats / opportunities;
    const avoidWeight = Math.min(Math.max((1 / 3 - repeatRate) * 1.8, 0), 0.40);
    return { repeatRate, avoidWeight, opportunities };
  }

  /** Mirror bias: אחרי הפסד, חלק מהשחקנים מחקים את מה שניצח אותם */
  function computeMirrorRate(games) {
    const sorted = games
      .filter(g => g.timestamp && CHOICES.includes(g.playerChoice))
      .sort((a, b) => a.timestamp - b.timestamp);

    let total = 0, hits = 0;
    for (let i = 1; i < sorted.length; i++) {
      const g = sorted[i], prev = sorted[i - 1];
      if (g.prevOutcome !== 'loss') continue;
      const w = g.w ?? 1;
      total += w;
      if (g.playerChoice === BEATS[prev.playerChoice]) hits += w;
    }

    if (total < 3) return { mirrorRate: 0, weight: 0 };
    const mirrorRate = hits / total;
    const weight     = Math.min(Math.max((mirrorRate - 1 / 3) * 2, 0), 0.30);
    return { mirrorRate, weight, total };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PROFILE BUILDER
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * בונה פרופיל מלא של שחקן מתוך נתוני Firebase.
   *
   * @param {object[]} allGamesRaw   כל ה-games (ללא סינון cheated)
   * @param {string|null} playerName שם השחקן, או null לכלל
   * @param {'app'|'physical'|null} mode
   * @returns {object} currentProfile
   */
  function buildProfile(allGamesRaw, playerName, mode) {
    const allGames = allGamesRaw.filter(g => !g.cheated && !g.cpuCheat);
    const name     = playerName || null;

    let personalGames = name
      ? allGames
          .filter(g => g.p1 === name || g.p2 === name)
          .map(g => ({
            ...g,
            playerChoice: g.p1 === name ? g.p1Choice : g.p2Choice,
            playerPos:    g.p1 === name ? g.p1ChoicePosition : g.p2ChoicePosition,
            playerColors: g.colors,
            prevOutcome:  g.p1 === name ? g.p1PrevOutcome : g.p2PrevOutcome,
          }))
          .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      : [];

    const globalGames      = buildGlobalGames(allGames);
    const recencyHL        = computeRecencyHalfLife(personalGames.length >= 3 ? personalGames : globalGames);
    const weightedPersonal = addRecencyWeights(personalGames, recencyHL, mode);
    const weightedGlobal   = addRecencyWeights(globalGames,   recencyHL, mode);
    const gamesForSignals  = personalGames.length >= 3 ? weightedPersonal : weightedGlobal;

    const relevantGames = personalGames.length >= 3 ? personalGames : buildGlobalGames(allGames);
    const sourceLabel   = personalGames.length >= 3
      ? `${name} (${personalGames.length} משחקים)`
      : name ? `כלל המשתמשים (אין מספיק נתונים על ${name})` : 'כלל המשתמשים';

    const stats       = computeStats(personalGames.length >= 3 ? weightedPersonal : weightedGlobal);
    const influence   = computeInfluence(gamesForSignals, weightedGlobal);
    const wsls        = computeWinStayLoseShiftWeights(gamesForSignals);
    const halfLife    = computeHalfLifeFromData(gamesForSignals);
    const transBias   = computeTransitionBias(gamesForSignals);
    const postTie     = computePostTieBias(gamesForSignals);
    const openingBias = computeOpeningBias(personalGames.length, weightedGlobal);
    const streakAvoid = computeStreakAvoidance(gamesForSignals);
    const mirrorBias  = computeMirrorRate(gamesForSignals);

    return {
      name, games: relevantGames, personalGames, allGames,
      stats, sourceLabel, influence, wsls, halfLife,
      transBias, postTie, openingBias, streakAvoid, mirrorBias,
      lastRound: null,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RECOMMENDATION BUILDER
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * בונה המלצה על סמך פרופיל + הקשר סיבוב נוכחי.
   *
   * @param {object} profile     מה שהחזיר buildProfile()
   * @param {object} [ctx={}]    הקשר סיבוב:
   *   ctx.positions  — { left, center, right }  (כל אחד: 'rock'|'paper'|'scissors'|null)
   *   ctx.colors     — { rock, paper, scissors } (hex strings)
   *   ctx.sessionHistory — [{ oppChoice, outcome, timestamp }]
   *
   * @returns {{
   *   beat: string,
   *   mostLikely: string,
   *   confidence: number,
   *   reason: string,
   *   adjProb: object,
   *   wsEffect: number,
   *   lsEffect: number
   * }}
   */
  function buildRecommendation(profile, ctx) {
    if (!profile) return null;
    ctx = ctx || {};
    const ctxPositions    = ctx.positions    || { left: null, center: null, right: null };
    const ctxColors       = ctx.colors       || {};
    const sessionHistory  = ctx.sessionHistory || [];

    const { stats, influence, wsls, halfLife } = profile;

    // 1. Base probabilities
    const baseProb = { ...stats.pcts };
    const bTotal   = baseProb.rock + baseProb.paper + baseProb.scissors;
    CHOICES.forEach(c => baseProb[c] /= bTotal);
    let adjProb = { ...baseProb };

    // 2. Position adjustment
    if (influence && Object.values(ctxPositions).some(Boolean)) {
      const pw = influence.posWeight;
      CHOICES.forEach(c => {
        const pos = Object.entries(ctxPositions).find(([, ch]) => ch === c)?.[0];
        if (!pos) return;
        const pg = (profile.games || []).filter(g => g.playerPos === pos);
        if (pg.length < 3) return;
        const histRate = pg.filter(g => g.playerChoice === c).length / pg.length;
        adjProb[c] = adjProb[c] * (1 - pw) + histRate * pw;
      });
    }

    // 3. Color adjustment
    if (influence && Object.keys(ctxColors).length) {
      const cw = influence.colorWeight;
      CHOICES.forEach(c => {
        const hex    = ctxColors[c];
        const bucket = hexToHueBucket(hex);
        const allCG  = (profile.games || []).filter(g => g.playerChoice === c);
        if (allCG.length < 3) return;
        const cg             = allCG.filter(g => hexToHueBucket(g.playerColors?.[c]) === bucket);
        const colorAttraction= cg.length / Math.max(allCG.length, 1);
        adjProb[c] = adjProb[c] * (1 - cw) + adjProb[c] * colorAttraction * cw;
      });
    }

    // 4. Shared temporal decay
    const lastRound = profile.lastRound;
    const elapsed   = lastRound ? Math.max(Date.now() - (lastRound.timestamp || Date.now()), 0) : 0;
    const decay     = lastRound ? (elapsed > 0 ? computeDecay(elapsed, halfLife) : 1) : 0;

    const reasonLines = [];
    let wsEffect = 0, lsEffect = 0;

    // 5. Win-Stay / Lose-Shift
    if (lastRound && wsls && decay > 0.05) {
      const { wsWeight, lsWeight } = wsls;
      if (lastRound.outcome === 'win' && wsWeight > 0.01 && lastRound.oppChoice) {
        const effectiveW = wsWeight * decay;
        CHOICES.forEach(c => {
          adjProb[c] = c === lastRound.oppChoice
            ? adjProb[c] * (1 - effectiveW) + effectiveW
            : adjProb[c] * (1 - effectiveW);
        });
        wsEffect = Math.round(effectiveW * 100);
        reasonLines.push(`🏆 win-stay: יחזור ל${HEB[lastRound.oppChoice]} (${wsEffect}% × ${Math.round(decay * 100)}% זיכרון)`);
      } else if (lastRound.outcome === 'loss' && lsWeight > 0.01 && lastRound.oppChoice) {
        const shifted    = BEATEN_BY[BEATEN_BY[lastRound.oppChoice]];
        const effectiveL = lsWeight * decay;
        CHOICES.forEach(c => {
          adjProb[c] = c === shifted
            ? adjProb[c] * (1 - effectiveL) + effectiveL
            : adjProb[c] * (1 - effectiveL);
        });
        lsEffect = Math.round(effectiveL * 100);
        reasonLines.push(`💔 lose-shift: יעבור ל${HEB[shifted]} (${lsEffect}% × ${Math.round(decay * 100)}% זיכרון)`);
      }
    }

    // 6. Transition bias
    const transBias = profile.transBias;
    if (transBias?.weight > 0.01 && lastRound?.oppChoice && decay > 0.05) {
      const oppPrevOut = lastRound.outcome === 'win' ? 'loss'
                       : lastRound.outcome === 'loss' ? 'win' : 'tie';
      const trans      = transBias.probs?.[lastRound.oppChoice]?.[oppPrevOut];
      if (trans) {
        const effectiveW = transBias.weight * decay;
        CHOICES.forEach(c => { adjProb[c] = adjProb[c] * (1 - effectiveW) + trans[c] * effectiveW; });
        const topT = CHOICES.reduce((a, b) => trans[a] > trans[b] ? a : b);
        reasonLines.push(`🔀 מעבר: ${HEB[lastRound.oppChoice]}+${oppPrevOut === 'loss' ? 'הפסד' : oppPrevOut === 'win' ? 'ניצחון' : 'תיקו'} → ${HEB[topT]} (${Math.round(trans[topT] * 100)}% · ${Math.round(decay * 100)}% זיכרון)`);
      }
    }

    // 7. Post-tie bias
    const postTie = profile.postTie;
    if (postTie?.probs && postTie.weight > 0.01 && lastRound?.outcome === 'tie' && decay > 0.05) {
      const effectiveW = postTie.weight * decay;
      CHOICES.forEach(c => { adjProb[c] = adjProb[c] * (1 - effectiveW) + postTie.probs[c] * effectiveW; });
      const topTie = CHOICES.reduce((a, b) => postTie.probs[a] > postTie.probs[b] ? a : b);
      reasonLines.push(`🤝 אחרי תיקו: נוטה ל${HEB[topTie]} (${Math.round(postTie.probs[topTie] * 100)}%)`);
    }

    // 8. Opening bias
    const openingBias = profile.openingBias;
    if (openingBias?.weight > 0.01) {
      const ow = openingBias.weight;
      adjProb.rock = adjProb.rock * (1 - ow) + (1 / 3 + openingBias.rockBias) * ow;
      reasonLines.push(`🎯 פתיחה: שחקן חדש — נטייה לאבן (${profile.personalGames.length}/${openingBias.cutoff} משחקים)`);
    }

    // 9. Streak avoidance
    const streakAvoid = profile.streakAvoid;
    if (streakAvoid && sessionHistory.length >= 2) {
      const sLast = sessionHistory[sessionHistory.length - 1];
      const sPrev = sessionHistory[sessionHistory.length - 2];
      if (sLast.oppChoice && sLast.oppChoice === sPrev.oppChoice) {
        const streakDecay = computeDecay(Date.now() - sLast.timestamp, halfLife);
        const effectiveW  = streakAvoid.avoidWeight * streakDecay;
        if (effectiveW > 0.01) {
          adjProb[sLast.oppChoice] *= Math.max(1 - effectiveW, 0);
          reasonLines.push(`⚡ רצף: ${HEB[sLast.oppChoice]} פעמיים ← לא יחזור (${Math.round(effectiveW * 100)}%)`);
        }
      }
    }

    // 10. Mirror bias
    const mirrorBias = profile.mirrorBias;
    if (mirrorBias?.weight > 0.01 && lastRound?.outcome === 'win' && lastRound.oppChoice && decay > 0.05) {
      const mirrorTarget = BEATS[lastRound.oppChoice];
      const effectiveW   = mirrorBias.weight * decay;
      CHOICES.forEach(c => {
        adjProb[c] = c === mirrorTarget
          ? adjProb[c] * (1 - effectiveW) + effectiveW
          : adjProb[c] * (1 - effectiveW);
      });
      reasonLines.push(`🪞 מראה: אחרי הפסד, יחקה ${HEB[mirrorTarget]} (${Math.round(effectiveW * 100)}% × ${Math.round(decay * 100)}% זיכרון)`);
    }

    // 11. Normalize
    const adjTotal = adjProb.rock + adjProb.paper + adjProb.scissors;
    CHOICES.forEach(c => adjProb[c] /= adjTotal);

    // 12. Blend with AI (25% weight) if aiProb provided
    const aiProb = ctx.aiProb;
    let aiBlendNote = null;
    if (aiProb && CHOICES.every(c => typeof aiProb[c] === 'number')) {
      const AI_WEIGHT = 0.25;
      CHOICES.forEach(c => {
        adjProb[c] = adjProb[c] * (1 - AI_WEIGHT) + aiProb[c] * AI_WEIGHT;
      });
      const aiTop = CHOICES.reduce((a, b) => aiProb[a] > aiProb[b] ? a : b);
      aiBlendNote = `🤖 AI (25%): ${HEB[aiTop]} (${Math.round(aiProb[aiTop] * 100)}%)`;
      // Re-normalize after blend
      const blendTotal = adjProb.rock + adjProb.paper + adjProb.scissors;
      CHOICES.forEach(c => adjProb[c] /= blendTotal);
    }

    // 13. Find best prediction
    const mostLikely = CHOICES.reduce((a, b) => adjProb[a] > adjProb[b] ? a : b);
    const beat       = BEATS[mostLikely];
    const confidence = Math.round(adjProb[mostLikely] * 100);

    // 14. Build reason text
    const lines = [];
    lines.push(`${profile.name || 'היריב'} בוחר ${HEB[mostLikely]} ${Math.round(baseProb[mostLikely] * 100)}% בסיס`);
    if (influence?.posWeight > 0.01 && Object.values(ctxPositions).some(Boolean))
      lines.push(`📍 מיקום: ${Math.round(influence.posWeight * 100)}%`);
    if (influence?.colorWeight > 0.01 && Object.keys(ctxColors).length)
      lines.push(`🎨 צבע: ${Math.round(influence.colorWeight * 100)}%`);
    lines.push(...reasonLines);
    if (aiBlendNote) lines.push(aiBlendNote);
    lines.push(`→ שחק ${HEB[beat]}`);

    return { beat, mostLikely, confidence, reason: lines.join('\n'), adjProb, wsEffect, lsEffect };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WIN PROBABILITY HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * מחזיר את אחוז הניצחון של השחקן לכל בחירה אפשרית,
   * בהתבסס על adjProb של היריב.
   * winPct[X] = הסיכוי שהיריב יבחר את מה שX מנצח.
   *
   * @param {object} adjProb  { rock, paper, scissors }  (סכום = 1)
   * @returns {{ rock: number, paper: number, scissors: number }}  0-100
   */
  function computeWinPcts(adjProb) {
    return {
      rock:     Math.round(adjProb.scissors * 100),   // אבן מנצחת מספריים
      paper:    Math.round(adjProb.rock     * 100),   // נייר מנצח אבן
      scissors: Math.round(adjProb.paper    * 100),   // מספריים מנצחות נייר
    };
  }

  /**
   * בוחר בחירה אקראית משוקללת לפי adjProb.
   * שימוש למחשב חכם פרובביליסטי.
   *
   * @param {object} adjProb  { rock, paper, scissors }
   * @returns {string}  'rock' | 'paper' | 'scissors'
   */
  function sampleWeighted(adjProb) {
    const r = Math.random();
    let cum = 0;
    for (const c of CHOICES) {
      cum += adjProb[c] || 0;
      if (r < cum) return c;
    }
    return CHOICES[2]; // fallback
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════════════════

  return {
    // constants (read-only)
    CHOICES,
    EMOJI,
    HEB,
    BEATS,
    BEATEN_BY,

    // helpers
    hexToHueBucket,
    computeDecay,

    // data prep
    buildGlobalGames,
    computeRecencyHalfLife,
    addRecencyWeights,

    // stats
    computeStats,

    // signals
    computeInfluence,
    computeWinStayLoseShiftWeights,
    computeHalfLifeFromData,
    computeTransitionBias,
    computePostTieBias,
    computeOpeningBias,
    computeStreakAvoidance,
    computeMirrorRate,

    // win probability helpers
    computeWinPcts,
    sampleWeighted,

    // main entry points
    buildProfile,
    buildRecommendation,
  };
}));