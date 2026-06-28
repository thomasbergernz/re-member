import { describe, it, expect } from "vitest";
import { formatAnchorDate, RENEWAL_ANCHOR_MONTH, RENEWAL_ANCHOR_DAY } from "./config";

// Anchor env vars are read at module load. With none set (the test default),
// they fall back to 1 July, so formatAnchorDate() renders "1 July".
describe("formatAnchorDate", () => {
  it("defaults to 1 July when no anchor env vars are set", () => {
    expect(RENEWAL_ANCHOR_MONTH).toBe(7);
    expect(RENEWAL_ANCHOR_DAY).toBe(1);
    expect(formatAnchorDate()).toBe("1 July");
  });
});
