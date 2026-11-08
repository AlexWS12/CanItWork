/**
 * How many ticks a screen will replay to rebuild a run: from a share link, a saved run, or a live session it joins late.
 * Replays run on the page's main thread, so this keeps one from freezing a tab. It is about 33 minutes at 1x for a
 * 10-tick-a-second domain. Runs pause here, and the live-session server refuses anything stamped past it, so whatever is
 * on a screen can always be shared and rebuilt.
 */
export const MAX_REPLAY_TICKS = 20_000;
