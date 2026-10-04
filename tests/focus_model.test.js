import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeFocusScore,
  computeTrendDelta,
  isDoomscrollSite,
  isProductiveSite,
  pruneTimestamps,
  updateEMA,
} from '../extension/src/background/focus_model.js';

const NOW = 1_800_000_000_000;

/** Signals for someone working steadily on a neutral site. */
function signals(overrides = {}) {
  return {
    tabSwitches: [],
    currentCategory: 'neutral',
    lastMouseMove: NOW - 1_000,
    lastKeyPress: NOW - 1_000,
    isActivelyTyping: false,
    scrollCount: 0,
    siteTime: {},
    ...overrides,
  };
}

function score(overrides, mode = 'normal') {
  return computeFocusScore(signals(overrides), {}, mode, NOW);
}

function penaltyTypes(result) {
  return result.penalties.map((p) => p.type);
}

test('steady work on a neutral site scores 100', () => {
  const result = score();
  assert.equal(result.score, 100);
  assert.deepEqual(result.penalties, []);
});

test('tab switches inside the last minute cost up to 35 points', () => {
  const switches = (n) => Array.from({ length: n }, (_, i) => NOW - 1_000 * (i + 1));

  assert.equal(score({ tabSwitches: switches(4) }).score, 86); // 4/10 * 35
  assert.equal(score({ tabSwitches: switches(10) }).score, 65);
  assert.equal(score({ tabSwitches: switches(40) }).score, 65); // capped
});

test('tab switches older than a minute are ignored', () => {
  const old = [NOW - 61_000, NOW - 120_000];
  assert.equal(score({ tabSwitches: old }).score, 100);
  assert.deepEqual(pruneTimestamps([NOW - 61_000, NOW - 59_000], NOW), [NOW - 59_000]);
});

test('stricter modes punish the same tab switching harder', () => {
  const tabSwitches = Array.from({ length: 5 }, (_, i) => NOW - 1_000 * (i + 1));
  const gentle = score({ tabSwitches }, 'gentle').score;
  const normal = score({ tabSwitches }, 'normal').score;
  const strict = score({ tabSwitches }, 'strict').score;
  assert.ok(gentle > normal && normal > strict, `${gentle} > ${normal} > ${strict}`);
});

test('distracting sites are penalized by category', () => {
  const social = score({ currentCategory: 'socialMedia' });
  assert.equal(social.score, 75); // 0.5 * 50
  assert.deepEqual(penaltyTypes(social), ['badSite']);
  assert.equal(score({ currentCategory: 'games' }).score, 70);
});

test('a productive site and active typing cannot push the score past 100', () => {
  const result = score({ currentCategory: 'productive', isActivelyTyping: true });
  assert.equal(result.score, 100);
  assert.deepEqual(result.bonuses.map((b) => b.type), ['goodSite', 'typing']);
});

test('idle time only counts after the mode threshold', () => {
  const idle = (ms) => score({ lastMouseMove: NOW - ms, lastKeyPress: NOW - ms });

  assert.equal(idle(29_000).score, 100);
  assert.equal(idle(60_000).score, 90); // 30s past threshold of a 60s ramp * 20
  assert.equal(idle(600_000).score, 80); // capped at 20
});

test('scrolling a distracting site adds a doomscroll penalty', () => {
  const calm = score({ currentCategory: 'socialMedia', scrollCount: 5 });
  const doom = score({ currentCategory: 'socialMedia', scrollCount: 20 });
  assert.ok(!penaltyTypes(calm).includes('doomscroll'));
  assert.ok(penaltyTypes(doom).includes('doomscroll'));
  assert.equal(doom.score, 50); // 100 - 25 site - 25 doomscroll
});

test('scrolling a productive site is not doomscrolling', () => {
  const result = score({ currentCategory: 'productive', scrollCount: 50 });
  assert.equal(result.score, 100);
});

test('long stretches on distracting sites add a prolonged penalty', () => {
  const siteTime = {
    'reddit.com': { category: 'socialMedia', totalMs: 150_000 },
    'docs.google.com': { category: 'productive', totalMs: 900_000 },
  };
  const result = score({ siteTime });
  assert.ok(penaltyTypes(result).includes('prolongedBadSite'));
  assert.equal(result.score, 90); // 150s of a 300s ramp * 20
  assert.equal(result.debug.badSiteTimeMs, 150_000);
});

test('the score never drops below zero', () => {
  const result = score(
    {
      currentCategory: 'games',
      scrollCount: 100,
      tabSwitches: Array.from({ length: 30 }, () => NOW - 500),
      lastMouseMove: NOW - 900_000,
      lastKeyPress: NOW - 900_000,
      siteTime: { 'x.com': { category: 'socialMedia', totalMs: 900_000 } },
    },
    'strict',
  );
  assert.equal(result.score, 0);
});

test('webcam signals are ignored unless vision is enabled', () => {
  const away = { facePresent: false, faceMissingMs: 70_000 };
  assert.equal(score(away).score, 100);

  const result = score({ ...away, visionEnabled: true });
  assert.deepEqual(penaltyTypes(result), ['faceAway']);
  assert.equal(result.score, 75);
});

test('a brief glance away is forgiven', () => {
  const glance = { visionEnabled: true, facePresent: true, lookingAway: true, lookingAwayMs: 4_000 };
  assert.equal(score(glance).score, 100);
  assert.ok(score({ ...glance, lookingAwayMs: 20_000 }).score < 100);
});

test('EMA moves 30% of the way toward the new score', () => {
  assert.equal(updateEMA(100, 0), 70);
  assert.equal(updateEMA(50, 50), 50);
});

test('trend is the change across the last 30 seconds', () => {
  const history = [
    { timestamp: NOW - 60_000, score: 10 }, // too old to count
    { timestamp: NOW - 25_000, score: 80 },
    { timestamp: NOW - 10_000, score: 70 },
    { timestamp: NOW - 1_000, score: 55 },
  ];
  assert.equal(computeTrendDelta(history, NOW), -25);
  assert.equal(computeTrendDelta(history.slice(0, 2), NOW), 0); // needs two points
});

test('site helpers classify URLs and survive bad input', () => {
  assert.equal(isDoomscrollSite('https://www.tiktok.com/foryou', {}), true);
  assert.equal(isDoomscrollSite('https://github.com/afafMaliha0716', {}), false);
  assert.equal(isProductiveSite('https://github.com/afafMaliha0716', {}), true);
  assert.equal(isDoomscrollSite('not a url', {}), false);
  assert.equal(isProductiveSite('', {}), false);
});
