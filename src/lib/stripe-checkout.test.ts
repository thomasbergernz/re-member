import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DateTime } from "luxon";
import {
  isPromoWindowNz,
  getNextJulyAnchorDate,
  getNextJulyAnchorEpoch,
  formatAmountNzd,
} from "./stripe-checkout";

const NZ = "Pacific/Auckland";

describe("isPromoWindowNz", () => {
  it("returns true for January", () => {
    expect(isPromoWindowNz(DateTime.fromISO("2026-01-15T12:00:00", { zone: NZ }))).toBe(true);
  });

  it("returns true for June", () => {
    expect(isPromoWindowNz(DateTime.fromISO("2026-06-30T23:59:59", { zone: NZ }))).toBe(true);
  });

  it("returns false for July", () => {
    expect(isPromoWindowNz(DateTime.fromISO("2026-07-01T00:00:01", { zone: NZ }))).toBe(false);
  });

  it("returns false for December", () => {
    expect(isPromoWindowNz(DateTime.fromISO("2026-12-15T12:00:00", { zone: NZ }))).toBe(false);
  });

  it("handles edge of June 30 midnight correctly", () => {
    // 2026-06-30T23:59:59 in NZ is still in promo window
    expect(isPromoWindowNz(DateTime.fromISO("2026-06-30T23:59:59", { zone: NZ }))).toBe(true);
  });
});

describe("getNextJulyAnchorDate", () => {
  it("returns this year's July 1 when before July", () => {
    const result = getNextJulyAnchorDate(DateTime.fromISO("2026-03-15T12:00:00", { zone: NZ }));
    expect(result.year).toBe(2026);
    expect(result.month).toBe(7);
    expect(result.day).toBe(1);
  });

  it("returns next year's July 1 when on July 1", () => {
    const result = getNextJulyAnchorDate(DateTime.fromISO("2026-07-01T00:00:00", { zone: NZ }));
    expect(result.year).toBe(2027);
    expect(result.month).toBe(7);
    expect(result.day).toBe(1);
  });

  it("returns next year's July 1 when in December", () => {
    const result = getNextJulyAnchorDate(DateTime.fromISO("2026-12-15T12:00:00", { zone: NZ }));
    expect(result.year).toBe(2027);
    expect(result.month).toBe(7);
    expect(result.day).toBe(1);
  });

  it("returns a Luxon DateTime at midnight NZ time", () => {
    const result = getNextJulyAnchorDate(DateTime.fromISO("2026-03-15T15:30:00", { zone: "UTC" }));
    expect(result.hour).toBe(0);
    expect(result.minute).toBe(0);
    expect(result.second).toBe(0);
    expect(result.zoneName).toBe(NZ);
  });
});

describe("getNextJulyAnchorEpoch", () => {
  it("returns a Unix timestamp for July 1 in NZ", () => {
    const epoch = getNextJulyAnchorEpoch(DateTime.fromISO("2026-03-15T12:00:00", { zone: NZ }));
    const expected = DateTime.fromISO("2026-07-01T00:00:00", { zone: NZ }).toSeconds();
    expect(epoch).toBe(Math.floor(expected));
  });

  it("returns a future timestamp even when called near July", () => {
    const epoch = getNextJulyAnchorEpoch(DateTime.fromISO("2026-07-01T00:00:00", { zone: NZ }));
    const expected = DateTime.fromISO("2027-07-01T00:00:00", { zone: NZ }).toSeconds();
    expect(epoch).toBe(Math.floor(expected));
  });
});

describe("formatAmountNzd", () => {
  it("formats cents as NZD dollars with two decimal places", () => {
    expect(formatAmountNzd(5000)).toBe("NZ$50.00");
    expect(formatAmountNzd(1250)).toBe("NZ$12.50");
    expect(formatAmountNzd(100)).toBe("NZ$1.00");
    expect(formatAmountNzd(9999)).toBe("NZ$99.99");
  });

  it("handles zero", () => {
    expect(formatAmountNzd(0)).toBe("NZ$0.00");
  });
});
