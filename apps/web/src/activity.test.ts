import { describe, expect, it } from "vitest";
import { ActivityTracker, VIDEO_ACTIVE_MAX_MS, VIDEO_GAP_MS } from "./activity";

const MIN = 60_000;
function setup() {
  let now = 0;
  const tracker = new ActivityTracker(5 * MIN, () => now);
  const seen: boolean[] = [];
  tracker.subscribe((idle) => seen.push(idle));
  return { tracker, seen, at: (t: number) => { now = t; tracker.check(); } };
}

describe("ActivityTracker", () => {
  it("turns idle after five minutes without activity and comes back on the first touch", () => {
    const { tracker, seen, at } = setup();
    at(4 * MIN + 59_000);
    expect(tracker.idle).toBe(false);
    at(5 * MIN);
    expect(tracker.idle).toBe(true);
    tracker.touch();
    expect(tracker.idle).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("counts from the last activity (input or speech)", () => {
    const { tracker, at } = setup();
    at(4 * MIN); tracker.touch();
    at(8 * MIN);
    expect(tracker.idle).toBe(false);
    at(9 * MIN);
    expect(tracker.idle).toBe(true);
  });

  it("never turns idle while the system-wide detector reports the user active", () => {
    const { tracker, at } = setup();
    tracker.setSystemIdle(false);
    at(30 * MIN);
    expect(tracker.idle).toBe(false);
    // The detector gives up (idle or screen locked): now the five minutes without input or speech decide, and they are over.
    tracker.setSystemIdle(true);
    expect(tracker.idle).toBe(true);
  });

  it("keeps somebody present who talks while the system is idle", () => {
    const { tracker, at } = setup();
    tracker.setSystemIdle(true);
    at(4 * MIN); tracker.touch(); // speaking
    at(6 * MIN);
    expect(tracker.idle).toBe(false);
  });

  it("stays present while a video plays, for at most four hours since the last input", () => {
    const { tracker, seen, at } = setup();
    tracker.setSystemIdle(true);
    tracker.setVideoPlaying(true);
    at(3 * 60 * MIN);
    expect(tracker.idle).toBe(false);
    at(VIDEO_ACTIVE_MAX_MS - 1000);
    expect(tracker.idle).toBe(false);
    at(VIDEO_ACTIVE_MAX_MS);
    expect(tracker.idle).toBe(true);
    // Input starts the four hours again.
    tracker.touch();
    at(VIDEO_ACTIVE_MAX_MS + 3 * 60 * MIN);
    expect(tracker.idle).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("stays present while a stream is watched inside Squorli (fullscreen, pinned), per place, with the four-hour limit", () => {
    const { tracker, seen, at } = setup();
    tracker.setWatching("fs:alice:screen", true);
    at(30 * MIN);
    expect(tracker.idle).toBe(false);
    tracker.setWatching("stage-pinned", true);
    tracker.setWatching("fs:alice:screen", false); // the other place still shows a stream
    at(60 * MIN);
    expect(tracker.idle).toBe(false);
    at(VIDEO_ACTIVE_MAX_MS);
    expect(tracker.idle).toBe(true);
    tracker.touch();
    expect(tracker.idle).toBe(false);
    tracker.setWatching("stage-pinned", false); // the last stream ends: the five minutes decide
    at(VIDEO_ACTIVE_MAX_MS + 4 * MIN);
    expect(tracker.idle).toBe(false);
    at(VIDEO_ACTIVE_MAX_MS + 5 * MIN);
    expect(tracker.idle).toBe(true);
    expect(seen).toEqual([true, false, true]);
  });

  it("bridges the gap between two videos, and a video that ended leaves the five minutes to decide", () => {
    const { tracker, at } = setup();
    tracker.setVideoPlaying(true);
    at(20 * MIN); tracker.setVideoPlaying(false);
    at(20 * MIN + VIDEO_GAP_MS - 1000);
    expect(tracker.idle).toBe(false);
    tracker.setVideoPlaying(true); // the next video of the playlist
    at(40 * MIN);
    expect(tracker.idle).toBe(false);
    tracker.setVideoPlaying(false);
    at(40 * MIN + VIDEO_GAP_MS);
    expect(tracker.idle).toBe(true);
  });

  it("counts the four hours from when the system-wide detector last saw the user", () => {
    const { tracker, at } = setup();
    tracker.setVideoPlaying(true);
    tracker.setSystemIdle(false);
    at(60 * MIN); // typing in another program until now
    tracker.setSystemIdle(true);
    at(60 * MIN + VIDEO_ACTIVE_MAX_MS - 1000);
    expect(tracker.idle).toBe(false);
    at(60 * MIN + VIDEO_ACTIVE_MAX_MS);
    expect(tracker.idle).toBe(true);
  });

  it("system activity ends an absence", () => {
    const { tracker, seen, at } = setup();
    tracker.setSystemIdle(true);
    at(5 * MIN);
    tracker.setSystemIdle(false);
    expect(seen).toEqual([true, false]);
  });
});
