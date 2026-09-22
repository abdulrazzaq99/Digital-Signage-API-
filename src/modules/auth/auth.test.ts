import jwt from "jsonwebtoken";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../config/env.js";
import { sha256 } from "../../core/auth/tokens.js";
import { redis } from "../../core/redis/client.js";
import { createUser } from "../../test/factories.js";
import { refreshGraceKey } from "./auth.service.js";
import { api, closeAll, resetDatabase } from "../../test/helpers.js";

beforeEach(resetDatabase);
afterAll(closeAll);

describe("POST /auth/login", () => {
  it("returns access and refresh tokens with the user", async () => {
    const user = await createUser({ email: "a@test.local" });
    const res = await api().post("/api/v1/auth/login").send({ email: "a@test.local", password: user.password });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ user: { email: "a@test.local" }, expiresIn: 900 });
    expect(res.body.data.accessToken).toBeTypeOf("string");
    expect(res.body.data.refreshToken).toBeTypeOf("string");
  });

  it("rejects a wrong password with INVALID_CREDENTIALS", async () => {
    await createUser({ email: "b@test.local" });
    const res = await api().post("/api/v1/auth/login").send({ email: "b@test.local", password: "nope-nope" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects an unknown email with the same error", async () => {
    const res = await api().post("/api/v1/auth/login").send({ email: "ghost@test.local", password: "whatever" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects a disabled account", async () => {
    const user = await createUser({ email: "c@test.local", isActive: false });
    const res = await api().post("/api/v1/auth/login").send({ email: "c@test.local", password: user.password });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_DISABLED");
  });

  it("validates the body", async () => {
    const res = await api().post("/api/v1/auth/login").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rate limits after 10 attempts per minute", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await api().post("/api/v1/auth/login").send({ email: "x@test.local", password: "bad-password" });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

describe("POST /auth/refresh", () => {
  it("rotates the refresh token and revokes the previous one", async () => {
    const user = await createUser();
    const first = (await api().post("/api/v1/auth/login").send({ email: user.email, password: user.password })).body.data;
    const second = await api().post("/api/v1/auth/refresh").send({ refreshToken: first.refreshToken });
    expect(second.status).toBe(200);
    expect(second.body.data.refreshToken).not.toBe(first.refreshToken);

    // Once the grace window has passed, reusing the rotated token must fail and revoke the family.
    await redis.del(refreshGraceKey(sha256(first.refreshToken)));
    const reuse = await api().post("/api/v1/auth/refresh").send({ refreshToken: first.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe("TOKEN_REUSED");
    const afterReuse = await api().post("/api/v1/auth/refresh").send({ refreshToken: second.body.data.refreshToken });
    expect(afterReuse.status).toBe(401);
  });

  it("returns the same new pair to concurrent refreshes with one token instead of logging the user out", async () => {
    const user = await createUser();
    const first = (await api().post("/api/v1/auth/login").send({ email: user.email, password: user.password })).body.data;
    const refresh = () => api().post("/api/v1/auth/refresh").send({ refreshToken: first.refreshToken });
    const [a, b] = await Promise.all([refresh(), refresh()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.data.refreshToken).toBe(a.body.data.refreshToken);
    // A late retry inside the window gets the same pair too, and the session stays alive.
    const retry = await api().post("/api/v1/auth/refresh").send({ refreshToken: first.refreshToken });
    expect(retry.status).toBe(200);
    expect(retry.body.data.refreshToken).toBe(a.body.data.refreshToken);
    const next = await api().post("/api/v1/auth/refresh").send({ refreshToken: a.body.data.refreshToken });
    expect(next.status).toBe(200);
  });

  it("does not revive a session through the grace window after logout", async () => {
    const user = await createUser();
    const first = (await api().post("/api/v1/auth/login").send({ email: user.email, password: user.password })).body.data;
    const second = (await api().post("/api/v1/auth/refresh").send({ refreshToken: first.refreshToken })).body.data;
    expect((await api().post("/api/v1/auth/logout").send({ refreshToken: second.refreshToken })).status).toBe(204);
    const replay = await api().post("/api/v1/auth/refresh").send({ refreshToken: first.refreshToken });
    expect(replay.status).toBe(401);
  });

  it("rejects garbage tokens", async () => {
    const res = await api().post("/api/v1/auth/refresh").send({ refreshToken: "nope" });
    expect(res.status).toBe(401);
  });
});

describe("GET /auth/me", () => {
  it("requires a bearer token", async () => {
    const res = await api().get("/api/v1/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns the current user", async () => {
    const user = await createUser();
    const { accessToken } = (await api().post("/api/v1/auth/login").send({ email: user.email, password: user.password })).body.data;
    const res = await api().get("/api/v1/auth/me").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(user.email);
  });

  it("reports an expired access token as TOKEN_EXPIRED", async () => {
    const user = await createUser();
    const expired = jwt.sign({ sub: user.id, email: user.email, name: user.name, platformRole: "CUSTOMER", companyRole: "ADMIN", companyId: null, type: "access" }, env.JWT_ACCESS_SECRET, { expiresIn: -10 });
    const res = await api().get("/api/v1/auth/me").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("TOKEN_EXPIRED");
  });
});

describe("password reset and change", () => {
  it("forgot-password always returns 202", async () => {
    const res = await api().post("/api/v1/auth/forgot-password").send({ email: "nobody@test.local" });
    expect(res.status).toBe(202);
  });

  it("change-password requires the current password and invalidates sessions", async () => {
    const user = await createUser();
    const tokens = (await api().post("/api/v1/auth/login").send({ email: user.email, password: user.password })).body.data;
    const bad = await api().post("/api/v1/auth/change-password").set("Authorization", `Bearer ${tokens.accessToken}`).send({ currentPassword: "wrong-one", newPassword: "NewPassw0rd!" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("PASSWORD_MISMATCH");
    const good = await api().post("/api/v1/auth/change-password").set("Authorization", `Bearer ${tokens.accessToken}`).send({ currentPassword: user.password, newPassword: "NewPassw0rd!" });
    expect(good.status).toBe(204);
    const refresh = await api().post("/api/v1/auth/refresh").send({ refreshToken: tokens.refreshToken });
    expect(refresh.status).toBe(401);
    const relogin = await api().post("/api/v1/auth/login").send({ email: user.email, password: "NewPassw0rd!" });
    expect(relogin.status).toBe(200);
  });
});
