import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock global fetch for the Mailgun probe. The health endpoint does
// fetch("https://api.mailgun.net/v3/{domain}", { ... }) with Basic auth.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock Stripe — control products.list behaviour per test.
const mockProductsList = vi.fn();
vi.mock("stripe", () => {
  const StripeCtor = vi.fn().mockImplementation(function (this: any) {
    this.products = { list: mockProductsList };
  });
  return { default: StripeCtor };
});

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

async function getHandler() {
  const mod = await import("./health");
  return mod.GET;
}

describe("/api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProductsList.mockResolvedValue({ data: [] });
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.MAILGUN_API_KEY;
    delete process.env.MAILGUN_DOMAIN;
  });

  describe("happy path", () => {
    it("returns 200 with both subsystems connected", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_ok";
      process.env.MAILGUN_API_KEY = "key-test";
      process.env.MAILGUN_DOMAIN = "mg.eldaa.org.nz";

      const GET = await getHandler();
      const res = await GET({} as never);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "ok", stripe: "connected", email: "connected" });
    });
  });

  describe("Stripe", () => {
    it("reports not_configured as degraded when STRIPE_SECRET_KEY is absent", async () => {
      process.env.MAILGUN_API_KEY = "key-test";
      process.env.MAILGUN_DOMAIN = "mg.eldaa.org.nz";

      const GET = await getHandler();
      const res = await GET({} as never);

      // 200 keeps the Fly liveness check green; body.status carries readiness.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("degraded");
      expect(body.stripe).toBe("not_configured");
      expect(body.email).toBe("connected");
    });

    it("reports disconnected and degraded (still 200) when products.list throws", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_bad";
      process.env.MAILGUN_API_KEY = "key-test";
      process.env.MAILGUN_DOMAIN = "mg.eldaa.org.nz";

      mockProductsList.mockRejectedValueOnce(new Error("Invalid API Key"));

      const GET = await getHandler();
      const res = await GET({} as never);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("degraded");
      expect(body.stripe).toBe("disconnected");
      expect(body.email).toBe("connected");
      expect(body.errors.stripe).toContain("Invalid API Key");
    });
  });

  describe("Mailgun", () => {
    it("reports not_configured as degraded when MAILGUN_API_KEY is missing", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_ok";
      // MAILGUN_API_KEY / MAILGUN_DOMAIN deliberately omitted.

      const GET = await getHandler();
      const res = await GET({} as never);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("degraded");
      expect(body.email).toBe("not_configured");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns connected when Mailgun returns 200", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_ok";
      process.env.MAILGUN_API_KEY = "key-test";
      process.env.MAILGUN_DOMAIN = "mg.eldaa.org.nz";

      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const GET = await getHandler();
      const res = await GET({} as never);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.email).toBe("connected");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.mailgun.net/v3/mg.eldaa.org.nz",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Basic /),
          }),
        }),
      );
    });

    it("reports disconnected and degraded (still 200) on 401 from Mailgun", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_ok";
      process.env.MAILGUN_API_KEY = "key-bad";
      process.env.MAILGUN_DOMAIN = "mg.eldaa.org.nz";

      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

      const GET = await getHandler();
      const res = await GET({} as never);

      // Dead credential must NOT 503 — that would take the whole Fly app offline.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("degraded");
      expect(body.email).toBe("disconnected");
      expect(body.stripe).toBe("connected");
      expect(body.errors.email).toContain("401");
    });

    it("reports disconnected and degraded (still 200) when fetch throws", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_ok";
      process.env.MAILGUN_API_KEY = "key-test";
      process.env.MAILGUN_DOMAIN = "mg.eldaa.org.nz";

      mockFetch.mockRejectedValueOnce(new Error("network unreachable"));

      const GET = await getHandler();
      const res = await GET({} as never);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("degraded");
      expect(body.email).toBe("disconnected");
      expect(body.errors.email).toContain("network unreachable");
    });

    it("reports both subsystems degraded (still 200)", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_bad";
      process.env.MAILGUN_API_KEY = "key-test";
      process.env.MAILGUN_DOMAIN = "mg.eldaa.org.nz";

      mockProductsList.mockRejectedValueOnce(new Error("Stripe down"));
      mockFetch.mockRejectedValueOnce(new Error("Mailgun down"));

      const GET = await getHandler();
      const res = await GET({} as never);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("degraded");
      expect(body.stripe).toBe("disconnected");
      expect(body.email).toBe("disconnected");
      expect(body.errors.stripe).toContain("Stripe down");
      expect(body.errors.email).toContain("Mailgun down");
    });
  });
});
