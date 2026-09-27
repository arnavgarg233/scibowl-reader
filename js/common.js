// Question categories, formats, NSB scoring and difficulty, shared by solo and multiplayer.

export const CATEGORIES = ['Biology', 'Chemistry', 'Earth and Space', 'Energy', 'Math', 'Physics', 'General Science'];
export const FORMATS = { mc: 'Multiple Choice', sa: 'Short Answer' };
export const POINTS = { tossup: 4, bonus: 10 };

// NSB coordinator manual: rounds 1-10 are about equal; from round 11 each round
// gets harder, with round 17 the hardest.
export function difficulty (q) {
  const r = parseInt(q.round);
  return r <= 10 ? 'standard' : r <= 14 ? 'hard' : 'hardest';
}
export const DIFFICULTIES = { standard: 'Rounds 1–10', hard: 'Rounds 11–14', hardest: 'Rounds 15–17' };
export const DIFFICULTY_NAMES = { standard: 'Round robin', hard: 'Elimination', hardest: 'Late elimination' };
