import jwt from "jsonwebtoken";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../config/env.js";
import { sha256 } from "../../core/auth/tokens.js";
import { redis } from "../../core/redis/client.js";
import { getMailProvider, setMailProvider } from "../../core/mail/index.js";
import { NoopMailProvider } from "../../core/mail/noop.js";
import { mailSend } from "../../jobs/mail.send.js";
import { createUser } from "../../test/factories.js";
import { linkToken, queuedMail } from "../../test/mail.js";
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
  it("forgot-password always returns 202 and mails nobody for an unknown address", async () => {
    const res = await api().post("/api/v1/auth/forgot-password").send({ email: "nobody@test.local" });
    expect(res.status).toBe(202);
    expect(await queuedMail("nobody@test.local")).toHaveLength(0);
  });

  it("emails an HTTPS-style reset link whose token sets a new password once", async () => {
    const user = await createUser();
    expect((await api().post("/api/v1/auth/forgot-password").send({ email: user.email })).status).toBe(202);
    const [mail] = await queuedMail(user.email);
    expect(mail?.subject).toMatch(/reset/i);
    expect(mail?.text).toContain(`${env.APP_PUBLIC_URL}/reset-password?token=`);
    expect(mail?.html).toContain("/reset-password?token=");
    const token = linkToken(mail);
    expect((await api().post("/api/v1/auth/reset-password").send({ token, password: "Fresh-Passw0rd" })).status).toBe(204);
    expect((await api().post("/api/v1/auth/login").send({ email: user.email, password: "Fresh-Passw0rd" })).status).toBe(200);
    const again = await api().post("/api/v1/auth/reset-password").send({ token, password: "Another-Passw0rd" });
    expect(again.body.error.code).toBe("RESET_INVALID");
  });

  it("the mail job delivers through the configured provider", async () => {
    const original = getMailProvider();
    const capture = new NoopMailProvider();
    setMailProvider(capture);
    try {
      await mailSend({ to: "someone@test.local", subject: "Hello", text: "Body" });
    } finally {
      setMailProvider(original);
    }
    expect(capture.sent).toEqual([{ to: "someone@test.local", subject: "Hello", text: "Body" }]);
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

describe("password rules", () => {
  it("reset rejects weak passwords and ones built from the email name, and keeps the link usable", async () => {
    const user = await createUser({ email: "sarah@test.local" });
    await api().post("/api/v1/auth/forgot-password").send({ email: user.email });
    const token = linkToken((await queuedMail(user.email))[0]);
    for (const weak of ["abcdefghij", "password1"]) {
      expect((await api().post("/api/v1/auth/reset-password").send({ token, password: weak })).status, weak).toBe(400);
    }
    const named = await api().post("/api/v1/auth/reset-password").send({ token, password: "Sarah-2026-Pass" });
    expect(named.status).toBe(400);
    expect(named.body.error.details).toEqual([{ path: "body.password", message: "Don't use your email name in your password" }]);
    expect((await api().post("/api/v1/auth/reset-password").send({ token, password: "Blue-Kettle-42" })).status).toBe(204);
  });

  it("change-password rejects reusing the current password or the email name", async () => {
    const user = await createUser({ email: "morgan@test.local" });
    const tokens = (await api().post("/api/v1/auth/login").send({ email: user.email, password: user.password })).body.data;
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const same = await api().post("/api/v1/auth/change-password").set(auth).send({ currentPassword: user.password, newPassword: user.password });
    expect(same.body.error.details).toEqual([{ path: "body.newPassword", message: "Choose a different password" }]);
    const named = await api().post("/api/v1/auth/change-password").set(auth).send({ currentPassword: user.password, newPassword: "Morgan-Pass-99" });
    expect(named.body.error.details).toEqual([{ path: "body.newPassword", message: "Don't use your email name in your password" }]);
  });

  it("login lower-cases the email and bounds the password and body", async () => {
    const user = await createUser({ email: "casey@test.local" });
    expect((await api().post("/api/v1/auth/login").send({ email: "  Casey@Test.LOCAL ", password: user.password })).status).toBe(200);
    expect((await api().post("/api/v1/auth/login").send({ email: user.email, password: "x".repeat(129) })).status).toBe(400);
    expect((await api().post("/api/v1/auth/login").send({ email: user.email, password: user.password, remember: true })).status).toBe(400);
  });
});
