// Focus score computation - multi-signal model
// Incorporates: tab switches, site categories, mouse/keyboard activity, scrolling

import { categorizeSite, getCategoryPenalty } from './storage.js';

const WINDOW_MS = 60_000; // 60 second rolling window
const EMA_ALPHA = 0.3;    // smoothing factor for trend

// ============================================================
// Mode-specific thresholds
// ============================================================

const MODE_CONFIG = {
  gentle: {
    tabSwitchThreshold: 15,    // switches before max penalty
    idleThresholdMs: 45_000,   // 45s before idle penalty
    typingBonus: 0.1,          // bonus for active typing
    baseScore: 100,
  },
  normal: {
    tabSwitchThreshold: 10,
    idleThresholdMs: 30_000,
    typingBonus: 0.15,
    baseScore: 100,
  },
  strict: {
    tabSwitchThreshold: 5,     // very sensitive
    idleThresholdMs: 20_000,   // 20s = idle
    typingBonus: 0.2,
    baseScore: 100,
  },
};

// ============================================================
// Utility Functions
// ============================================================

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

export function pruneTimestamps(arr, now) {
  const cutoff = now - WINDOW_MS;
  return arr.filter((t) => t > cutoff);
}

// ============================================================
// Focus Score Computation
// ============================================================

/**
 * Compute focus score from all signals
 * Returns 0-100 where 100 = fully focused
 *
 * `now` defaults to the current time; tests pass a fixed value.
 */
export function computeFocusScore(signals, settings, mode = 'normal', now = Date.now()) {
  const config = MODE_CONFIG[mode] || MODE_CONFIG.normal;

  let score = config.baseScore;
  const penalties = [];
  const bonuses = [];

  // ─────────────────────────────────────────────────────────
  // 1. TAB SWITCHING PENALTY
  // ─────────────────────────────────────────────────────────
  const recentSwitches = pruneTimestamps(signals.tabSwitches || [], now);
  const switchRate = recentSwitches.length;
  const tabPenalty = clamp01(switchRate / config.tabSwitchThreshold) * 35;
  score -= tabPenalty;
  if (tabPenalty > 0) penalties.push({ type: 'tabSwitch', value: tabPenalty });

  // ─────────────────────────────────────────────────────────
  // 2. SITE CATEGORY PENALTY/BONUS
  // ─────────────────────────────────────────────────────────
  const currentCategory = signals.currentCategory || 'neutral';
  const categoryMultiplier = getCategoryPenalty(currentCategory, mode);

  if (categoryMultiplier < 0) {
    // Penalty - scale by how bad the category is
    const sitePenalty = Math.abs(categoryMultiplier) * 50;
    score -= sitePenalty;
    penalties.push({ type: 'badSite', category: currentCategory, value: sitePenalty });
  } else if (categoryMultiplier > 0) {
    // Bonus for productive sites
    const siteBonus = categoryMultiplier * 20;
    score += siteBonus;
    bonuses.push({ type: 'goodSite', category: currentCategory, value: siteBonus });
  }

  // ─────────────────────────────────────────────────────────
  // 3. IDLE PENALTY (no mouse/keyboard activity)
  // ─────────────────────────────────────────────────────────
  const lastActivity = Math.max(
    signals.lastMouseMove || 0,
    signals.lastKeyPress || 0
  );
  const idleMs = lastActivity > 0 ? now - lastActivity : 0;

  if (idleMs > config.idleThresholdMs) {
    const idlePenalty = clamp01((idleMs - config.idleThresholdMs) / 60_000) * 20;
    score -= idlePenalty;
    penalties.push({ type: 'idle', value: idlePenalty });
  }

  // ─────────────────────────────────────────────────────────
  // 4. ACTIVE TYPING BONUS
  // ─────────────────────────────────────────────────────────
  if (signals.isActivelyTyping) {
    const typingBonus = config.typingBonus * 15;
    score += typingBonus;
    bonuses.push({ type: 'typing', value: typingBonus });
  }

  // ─────────────────────────────────────────────────────────
  // 5. DOOMSCROLLING PENALTY
  // ─────────────────────────────────────────────────────────
  // Scrolling on a bad site = doomscrolling
  const isBadSite = ['socialMedia', 'entertainment', 'games', 'blocked'].includes(currentCategory);

  if (isBadSite && signals.scrollCount > 5) {
    const doomPenalty = clamp01(signals.scrollCount / 20) * 25;
    score -= doomPenalty;
    penalties.push({ type: 'doomscroll', value: doomPenalty });
  }

  // ─────────────────────────────────────────────────────────
  // 6. PROLONGED BAD SITE PENALTY
  // ─────────────────────────────────────────────────────────
  // Extra penalty for spending lots of time on bad sites
  const siteTime = signals.siteTime || {};
  let badSiteTimeMs = 0;

  for (const [hostname, data] of Object.entries(siteTime)) {
    const cat = data.category;
    if (['socialMedia', 'entertainment', 'games', 'blocked'].includes(cat)) {
      badSiteTimeMs += data.totalMs || 0;
    }
  }

  if (badSiteTimeMs > 30_000) { // More than 30s on bad sites
    const prolongedPenalty = clamp01(badSiteTimeMs / 300_000) * 20; // Max at 5 min
    score -= prolongedPenalty;
    penalties.push({ type: 'prolongedBadSite', value: prolongedPenalty });
  }

  // ─────────────────────────────────────────────────────────
  // 7. STRICT MODE: EXTRA PENALTIES
  // ─────────────────────────────────────────────────────────
  if (mode === 'strict') {
    // Any non-productive site gets a small penalty
    if (currentCategory !== 'productive') {
      score -= 5;
    }

    // Mouse not moving but not typing = distracted?
    if (!signals.isActivelyTyping && idleMs > 10_000) {
      score -= 5;
    }
  }

  // ─────────────────────────────────────────────────────────
  // 8. VISION-BASED PENALTIES (from webcam detection)
  // ─────────────────────────────────────────────────────────
  if (signals.visionEnabled) {
    // Face missing penalty - gradually increases
    if (!signals.facePresent && signals.faceMissingMs > 10_000) {
      // After 10 seconds of no face, start penalizing
      const faceMissingPenalty = clamp01((signals.faceMissingMs - 10_000) / 60_000) * 25;
      score -= faceMissingPenalty;
      penalties.push({ type: 'faceAway', value: faceMissingPenalty });
    }

    // Looking away penalty
    if (signals.lookingAway && signals.lookingAwayMs > 5_000) {
      // After 5 seconds of looking away, start penalizing
      const lookingAwayPenalty = clamp01((signals.lookingAwayMs - 5_000) / 30_000) * 15;
      score -= lookingAwayPenalty;
      penalties.push({ type: 'lookingAway', value: lookingAwayPenalty });
    }

    // Bonus for being visually focused
    if (signals.facePresent && !signals.lookingAway && signals.visionAttentionScore > 0.7) {
      const visionBonus = 5;
      score += visionBonus;
      bonuses.push({ type: 'visuallyFocused', value: visionBonus });
    }
  }

  // ─────────────────────────────────────────────────────────
  // FINAL SCORE
  // ─────────────────────────────────────────────────────────
  const finalScore = clamp(Math.round(score), 0, 100);

  return {
    score: finalScore,
    penalties,
    bonuses,
    debug: {
      switchRate,
      currentCategory,
      idleMs,
      badSiteTimeMs,
    },
  };
}

/**
 * Simple score computation (returns just the number)
 */
export function computeFocusScoreSimple(signals, settings, mode = 'normal') {
  return computeFocusScore(signals, settings, mode).score;
}

// ============================================================
// Trend Tracking
// ============================================================

export function updateEMA(currentEMA, newScore) {
  return EMA_ALPHA * newScore + (1 - EMA_ALPHA) * currentEMA;
}

export function computeTrendDelta(history, now) {
  const cutoff = now - 30_000;
  const recent = history.filter((h) => h.timestamp > cutoff);

  if (recent.length < 2) return 0;

  const oldest = recent[0].score;
  const newest = recent[recent.length - 1].score;

  return newest - oldest;
}

// ============================================================
// Site Detection Helpers
// ============================================================

export function isDoomscrollSite(url, settings) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    const category = categorizeSite(hostname, settings);
    return ['socialMedia', 'entertainment', 'games', 'blocked'].includes(category);
  } catch {
    return false;
  }
}

export function isProductiveSite(url, settings) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    const category = categorizeSite(hostname, settings);
    return category === 'productive';
  } catch {
    return false;
  }
}

export { categorizeSite };
