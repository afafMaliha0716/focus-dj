import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERVENTIONS,
  MUSIC_ARMS,
  deltaToReward,
  evaluateIntervention,
  selectArmUCB,
  selectIntervention,
  shouldIntervene,
  updateBanditArm,
} from '../extension/src/background/decision_engine.js';

const NOW = 1_800_000_000_000;

function policy(overrides = {}) {
  return {
    arms: {
      BOOST_ENERGY: { value: 0.5, n: 1 },
      SWITCH_PLAYLIST: { value: 0.5, n: 1 },
      PATTERN_BREAK: { value: 0.5, n: 1 },
      SMART_RECOMMEND: { value: 0.6, n: 1 },
      NUCLEAR: { value: 0.2, n: 1 },
      ...overrides,
    },
  };
}

function state(overrides = {}) {
  return {
    session: { active: true, phase: 'study', mode: 'normal' },
    metrics: { focusScore: 90, trendDelta: 0 },
    signals: { currentCategory: 'neutral', isDoomscrolling: false },
    settings: { nuclearEnabled: false },
    policy: policy(),
    lastIntervention: null,
    history: [],
    ...overrides,
  };
}

// ── shouldIntervene ─────────────────────────────────────────

test('no intervention outside an active study session', () => {
  const idle = state({ session: { active: false, phase: 'study', mode: 'normal' } });
  const onBreak = state({ session: { active: true, phase: 'break', mode: 'normal' } });
  assert.deepEqual(shouldIntervene(idle, NOW), { should: false, reason: 'not_studying' });
  assert.equal(shouldIntervene(onBreak, NOW).should, false);
});

test('no intervention while focused', () => {
  assert.deepEqual(shouldIntervene(state(), NOW), { should: false, reason: 'focused' });
});

test('low focus triggers an intervention, with a threshold per mode', () => {
  const at = (focusScore, mode) =>
    shouldIntervene(
      state({ metrics: { focusScore, trendDelta: 0 }, session: { active: true, phase: 'study', mode } }),
      NOW,
    ).should;

  assert.equal(at(50, 'gentle'), false);
  assert.equal(at(50, 'normal'), true);
  assert.equal(at(70, 'normal'), false);
  assert.equal(at(70, 'strict'), true);
});

test('a fast drop triggers an intervention even when focus is still high', () => {
  const dropping = state({ metrics: { focusScore: 85, trendDelta: -12 } });
  assert.deepEqual(shouldIntervene(dropping, NOW), { should: true, reason: 'dropping_focus' });
});

test('cooldown blocks back-to-back interventions', () => {
  const low = { metrics: { focusScore: 20, trendDelta: 0 } };
  const recent = state({ ...low, lastIntervention: { appliedAt: NOW - 10_000 } });
  const older = state({ ...low, lastIntervention: { appliedAt: NOW - 31_000 } });
  assert.deepEqual(shouldIntervene(recent, NOW), { should: false, reason: 'cooldown' });
  assert.equal(shouldIntervene(older, NOW).should, true);
});

test('strict mode intervenes on doomscrolling regardless of score', () => {
  const doom = state({
    session: { active: true, phase: 'study', mode: 'strict' },
    signals: { isDoomscrolling: true },
  });
  assert.deepEqual(shouldIntervene(doom, NOW), { should: true, reason: 'doomscrolling' });
});

// ── UCB1 bandit ─────────────────────────────────────────────

test('with equal experience, UCB picks the arm with the best value', () => {
  assert.equal(selectArmUCB(policy()), 'SMART_RECOMMEND');
});

test('NUCLEAR is never picked unless explicitly allowed', () => {
  const p = policy({ NUCLEAR: { value: 5, n: 1 } });
  assert.notEqual(selectArmUCB(p), 'NUCLEAR');
  assert.equal(selectArmUCB(p, false), 'NUCLEAR');
});

test('an arm that has never been tried is picked first', () => {
  const p = policy({ PATTERN_BREAK: { value: 0, n: 0 } });
  assert.equal(selectArmUCB(p), 'PATTERN_BREAK');
});

test('an all-untried policy still returns a real arm', () => {
  const p = { arms: { BOOST_ENERGY: { value: 0, n: 0 }, PATTERN_BREAK: { value: 0, n: 0 } } };
  assert.equal(selectArmUCB(p), 'BOOST_ENERGY');
});

test('exploration: a rarely tried arm eventually beats a well-worn one', () => {
  const p = policy({
    SMART_RECOMMEND: { value: 0.6, n: 200 },
    BOOST_ENERGY: { value: 0.5, n: 2 },
    SWITCH_PLAYLIST: { value: 0.1, n: 200 },
    PATTERN_BREAK: { value: 0.1, n: 200 },
  });
  assert.equal(selectArmUCB(p), 'BOOST_ENERGY');
});

test('`only` restricts the choice to the given arms', () => {
  const p = policy({ SMART_RECOMMEND: { value: 0.9, n: 1 } });
  assert.equal(selectArmUCB(p, true, ['BOOST_ENERGY', 'PATTERN_BREAK']), 'BOOST_ENERGY');
});

test('rewards update an arm with an incremental mean', () => {
  const p = policy();
  updateBanditArm(p, 'BOOST_ENERGY', 1);
  assert.deepEqual(p.arms.BOOST_ENERGY, { value: 0.75, n: 2 });
  updateBanditArm(p, 'BOOST_ENERGY', 0);
  assert.deepEqual(p.arms.BOOST_ENERGY, { value: 0.5, n: 3 });
});

test('rewards for interventions without an arm are ignored', () => {
  const p = policy();
  assert.deepEqual(updateBanditArm(p, 'VIOLA_POPUP', 1), policy());
});

test('focus delta maps onto a 0 to 1 reward', () => {
  assert.equal(deltaToReward(-15), 0);
  assert.equal(deltaToReward(0), 0.5);
  assert.equal(deltaToReward(15), 1);
  assert.equal(deltaToReward(-40), 0);
  assert.equal(deltaToReward(40), 1);
});

test('evaluating an intervention rewards its arm by the focus change', () => {
  const s = state({ lastIntervention: { type: 'PATTERN_BREAK', preScore: 40, appliedAt: NOW } });
  const result = evaluateIntervention(s, 55);
  assert.equal(result.evaluated, true);
  assert.equal(result.delta, 15);
  assert.equal(result.reward, 1);
  assert.deepEqual(result.policy.arms.PATTERN_BREAK, { value: 0.75, n: 2 });
  assert.deepEqual(evaluateIntervention(state(), 55), { evaluated: false });
});

test('the bandit learns: an arm that keeps failing stops being chosen', () => {
  const p = policy();
  for (let i = 0; i < 20; i++) updateBanditArm(p, 'SMART_RECOMMEND', 0);
  assert.notEqual(selectArmUCB(p, true, MUSIC_ARMS), 'SMART_RECOMMEND');
});

// ── selectIntervention ──────────────────────────────────────

function pick(overrides, isDoomscrolling = false) {
  return selectIntervention(state(overrides), isDoomscrolling, NOW);
}

test('nuclear fires only for doomscrolling in strict mode with it enabled', () => {
  const strict = { session: { active: true, phase: 'study', mode: 'strict' } };
  assert.equal(pick({ ...strict, settings: { nuclearEnabled: true } }, true), INTERVENTIONS.NUCLEAR);
  assert.notEqual(pick({ ...strict, settings: { nuclearEnabled: false } }, true), INTERVENTIONS.NUCLEAR);
  assert.notEqual(pick({ settings: { nuclearEnabled: true } }, true), INTERVENTIONS.NUCLEAR);
});

test('low focus on a distracting site shows the Viola popup', () => {
  const distracted = {
    metrics: { focusScore: 40, trendDelta: 0 },
    signals: { currentCategory: 'socialMedia' },
  };
  assert.equal(pick(distracted), INTERVENTIONS.VIOLA_POPUP);
});

test('the Viola popup is not repeated within two minutes', () => {
  const distracted = {
    metrics: { focusScore: 40, trendDelta: 0 },
    signals: { currentCategory: 'socialMedia' },
    lastIntervention: { type: INTERVENTIONS.VIOLA_POPUP, appliedAt: NOW - 60_000 },
  };
  assert.notEqual(pick(distracted), INTERVENTIONS.VIOLA_POPUP);
});

test('when focus drops, the bandit chooses among the music interventions', () => {
  const low = { metrics: { focusScore: 55, trendDelta: 0 } };
  assert.equal(pick(low), INTERVENTIONS.SMART_RECOMMEND);

  const learned = policy({
    SMART_RECOMMEND: { value: 0.05, n: 30 },
    BOOST_ENERGY: { value: 0.3, n: 30 },
    SWITCH_PLAYLIST: { value: 0.3, n: 30 },
    PATTERN_BREAK: { value: 0.9, n: 30 },
  });
  assert.equal(pick({ ...low, policy: learned }), INTERVENTIONS.PATTERN_BREAK);
});

test('music interventions never include nuclear or the popup', () => {
  assert.ok(!MUSIC_ARMS.includes(INTERVENTIONS.NUCLEAR));
  assert.ok(!MUSIC_ARMS.includes(INTERVENTIONS.VIOLA_POPUP));
});
