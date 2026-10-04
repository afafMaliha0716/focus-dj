// Decision engine: state machine + multi-armed bandit for intervention selection

/**
 * Intervention types (ordered by intensity)
 */
export const INTERVENTIONS = {
  BOOST_ENERGY: 'BOOST_ENERGY',       // Skip to higher energy track
  SWITCH_PLAYLIST: 'SWITCH_PLAYLIST', // Change to focus playlist
  PATTERN_BREAK: 'PATTERN_BREAK',     // Short pause then resume
  DUCK_VOLUME: 'DUCK_VOLUME',         // Lower volume to reduce distraction
  WHITE_NOISE: 'WHITE_NOISE',         // White noise burst for attention
  SMART_RECOMMEND: 'SMART_RECOMMEND', // AI-powered track recommendation based on BPM-focus correlation
  VIOLA_POPUP: 'VIOLA_POPUP',         // Show Viola chatbot popup
  NUCLEAR: 'NUCLEAR',                 // Max volume blast for doomscrolling
};

/**
 * Cooldown periods by mode (ms)
 * Stricter modes = more frequent interventions
 */
const COOLDOWNS = {
  gentle: 60_000,  // 60s - more patience
  normal: 30_000,  // 30s
  strict: 10_000,  // 10s - rapid response
};

/**
 * Focus thresholds by mode (trigger intervention if below)
 * Higher = more sensitive
 */
const THRESHOLDS = {
  gentle: 45,   // lenient
  normal: 60,   // moderate
  strict: 75,   // very sensitive - intervene early
};

/**
 * Trend sensitivity by mode (trigger if dropping faster than this)
 */
const TREND_THRESHOLDS = {
  gentle: -15,  // only intervene on rapid drops
  normal: -10,
  strict: -5,   // intervene on any noticeable drop
};

/**
 * Check if we should intervene based on current state
 */
export function shouldIntervene(state, now) {
  const { session, metrics, lastIntervention } = state;

  // Not in active session
  if (!session.active || session.phase !== 'study') {
    return { should: false, reason: 'not_studying' };
  }

  // Cooldown check
  const cooldown = COOLDOWNS[session.mode];
  if (lastIntervention && now - lastIntervention.appliedAt < cooldown) {
    return { should: false, reason: 'cooldown' };
  }

  // Focus is low
  const threshold = THRESHOLDS[session.mode];
  if (metrics.focusScore < threshold) {
    return { should: true, reason: 'low_focus' };
  }

  // Focus is dropping (mode-specific sensitivity)
  const trendThreshold = TREND_THRESHOLDS[session.mode] || -10;
  if (metrics.trendDelta < trendThreshold) {
    return { should: true, reason: 'dropping_focus' };
  }

  // Strict mode: intervene on any doomscrolling regardless of score
  if (session.mode === 'strict' && state.signals?.isDoomscrolling) {
    return { should: true, reason: 'doomscrolling' };
  }

  return { should: false, reason: 'focused' };
}

/**
 * Interventions that change the music. When focus drops, the bandit picks
 * among these, so the extension learns which one works for this user.
 */
export const MUSIC_ARMS = [
  INTERVENTIONS.BOOST_ENERGY,
  INTERVENTIONS.SWITCH_PLAYLIST,
  INTERVENTIONS.PATTERN_BREAK,
  INTERVENTIONS.SMART_RECOMMEND,
];

/**
 * UCB1 algorithm for selecting intervention arm
 * Balances exploitation (what worked) with exploration (trying new things)
 *
 * `only`, when given, limits the choice to those arm names.
 */
export function selectArmUCB(policy, excludeNuclear = true, only = null) {
  const arms = Object.entries(policy.arms).filter(([name]) => {
    if (excludeNuclear && name === 'NUCLEAR') return false;
    return !only || only.includes(name);
  });
  // Count pulls across the arms actually in play, so excluded arms
  // don't inflate the exploration bonus.
  const totalN = arms.reduce((sum, [_, arm]) => sum + arm.n, 0);

  let best = null;
  let bestScore = -Infinity;

  for (const [name, arm] of arms) {
    // An arm that has never been tried goes first. Without this guard,
    // n = 0 gives 0/0 = NaN, which loses every comparison forever.
    if (arm.n === 0) return name;

    // UCB1 formula: value + exploration bonus
    const explorationBonus = Math.sqrt((2 * Math.log(totalN)) / arm.n);
    const ucbScore = arm.value + explorationBonus;

    if (ucbScore > bestScore) {
      bestScore = ucbScore;
      best = name;
    }
  }

  return best || 'BOOST_ENERGY'; // fallback
}

/**
 * Select intervention based on context
 * Escalates if previous interventions didn't work
 */
export function selectIntervention(state, isDoomscrolling, now = Date.now()) {
  const { session, policy, settings, lastIntervention, signals } = state;

  // Check if we're escalating (previous intervention didn't help)
  const isEscalating = lastIntervention &&
    (now - lastIntervention.appliedAt < 60000) && // Within last minute
    lastIntervention.type !== INTERVENTIONS.VIOLA_POPUP &&
    lastIntervention.type !== INTERVENTIONS.NUCLEAR;

  // Check if on unproductive site
  const onUnproductiveSite = ['socialMedia', 'entertainment', 'games', 'blocked'].includes(signals?.currentCategory);

  // Nuclear only for doomscrolling in strict mode with it enabled
  if (isDoomscrolling && session.mode === 'strict' && settings.nuclearEnabled) {
    return INTERVENTIONS.NUCLEAR;
  }

  // VIOLA POPUP: Show on unproductive sites when focus is low
  // This is the "hey, you're distracted" nudge
  if (onUnproductiveSite && state.metrics.focusScore < 60) {
    // Don't spam - check if we showed popup recently
    const recentPopup = lastIntervention?.type === INTERVENTIONS.VIOLA_POPUP &&
      (now - lastIntervention.appliedAt < 120000); // 2 min cooldown for popup

    if (!recentPopup) {
      console.log(`[Decision] Viola popup: on ${signals?.currentCategory} site, focus ${state.metrics.focusScore}`);
      return INTERVENTIONS.VIOLA_POPUP;
    }
  }

  // If escalating and still distracted, show Viola popup
  if (isEscalating && state.metrics.focusScore < 50) {
    return INTERVENTIONS.VIOLA_POPUP;
  }

  // White noise for severe distraction
  if (state.metrics.focusScore < 30 && isDoomscrolling) {
    return INTERVENTIONS.WHITE_NOISE;
  }

  // AUTO MUSIC SWITCH: If enabled and focus is below threshold, use smart recommend
  const autoMusicEnabled = settings.autoMusicSwitch !== false; // Default true
  const autoThreshold = settings.autoMusicThreshold || 70; // Higher = more sensitive

  if (autoMusicEnabled && state.metrics.focusScore < autoThreshold) {
    // Music helps refocus. Let the bandit pick which music change to make:
    // smart recommend starts with the best prior, so it is tried first, but
    // if it stops helping this user the other arms take over.
    const arm = selectArmUCB(policy, true, MUSIC_ARMS);
    console.log(`[Decision] Auto music switch: focus ${state.metrics.focusScore} < threshold ${autoThreshold} -> ${arm}`);
    return arm;
  }

  // Otherwise use bandit to select best intervention
  return selectArmUCB(policy, true);
}

/**
 * Get escalation level based on recent interventions
 */
export function getEscalationLevel(state) {
  const recentInterventions = state.history
    .filter(h => h.intervention && (Date.now() - h.timestamp) < 300000) // Last 5 min
    .length;

  if (recentInterventions >= 4) return 'high';
  if (recentInterventions >= 2) return 'medium';
  return 'low';
}

/**
 * Update bandit arm after observing outcome
 * Uses incremental mean update
 */
export function updateBanditArm(policy, armName, reward) {
  const arm = policy.arms[armName];
  // Interventions the bandit doesn't choose between (popup, white noise)
  // have no arm, so there is nothing to learn from them.
  if (!arm) return policy;

  // Incremental mean: new_mean = old_mean + (reward - old_mean) / n
  arm.n += 1;
  arm.value = arm.value + (reward - arm.value) / arm.n;

  return policy;
}

/**
 * Convert focus delta to reward (0-1 scale)
 * delta of -15 = 0, delta of +15 = 1
 */
export function deltaToReward(focusDelta) {
  return Math.max(0, Math.min(1, (focusDelta + 15) / 30));
}

/**
 * Evaluate the outcome of an intervention
 * Should be called ~45s after intervention
 */
export function evaluateIntervention(state, currentScore) {
  const { lastIntervention, policy } = state;

  if (!lastIntervention) {
    return { evaluated: false };
  }

  const delta = currentScore - lastIntervention.preScore;
  const reward = deltaToReward(delta);

  const updatedPolicy = updateBanditArm(policy, lastIntervention.type, reward);

  return {
    evaluated: true,
    delta,
    reward,
    policy: updatedPolicy,
    interventionType: lastIntervention.type,
  };
}

/**
 * Get intervention intensity description (for UI)
 */
export function getInterventionDescription(type) {
  switch (type) {
    case INTERVENTIONS.BOOST_ENERGY:
      return 'Boosting music energy';
    case INTERVENTIONS.SWITCH_PLAYLIST:
      return 'Switching to focus playlist';
    case INTERVENTIONS.PATTERN_BREAK:
      return 'Pattern break audio cue';
    case INTERVENTIONS.SMART_RECOMMEND:
      return 'Playing AI-recommended track';
    case INTERVENTIONS.NUCLEAR:
      return 'WAKE UP! (Doomscroll detected)';
    default:
      return 'Adjusting music';
  }
}
