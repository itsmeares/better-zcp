import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /auth/change-password had no MAXIMUM password length check, unlike
// its three siblings: POST /auth/users (createUser, services/auth.js:401-
// 402), POST /auth/reset-password (both the route's own check at auth.js
// and authService.resetPassword's), and services/auth.js's own resetPassword
// -- all cap at 128 characters. Two real consequences of the gap: (1)
// bcrypt silently truncates its input at 72 BYTES, so any two passwords
// sharing the same first 72 bytes become interchangeable for login -- a
// user setting an arbitrarily long passphrase has no idea only its prefix
// matters; (2) bcrypt is deliberately slow, so an authenticated caller could
// spend meaningfully more server CPU per request than every other
// password-setting path in this file permits (bounded only by the app-wide
// 1MB JSON body limit, not by anything password-specific).

const authenticateAccessToken = vi.fn();
const changePassword = vi.fn();

vi.mock("../services/auth.js", () => ({
  default: {
    authenticateAccessToken,
    changePassword,
  },
  USER_ROLES: ["admin", "technician", "moderator"],
  requireRole: () => (req, res, next) => next(),
}));

const { default: router } = await import("../routes/auth.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn(), clearCookie: vi.fn() };
  response.status.mockReturnValue(response);
  response.clearCookie.mockReturnValue(response);
  return response;
}

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function postChangePassword(body) {
  const response = createResponse();
  await getHandler("/change-password", "post")(
    {
      headers: { authorization: "Bearer faketoken" },
      cookies: {},
      body,
    },
    response,
  );
  return response;
}

describe("POST /auth/change-password: newPassword must be capped at 128 characters, same as its siblings", () => {
  beforeEach(() => {
    authenticateAccessToken.mockReset().mockResolvedValue({ userId: "u1", username: "admin" });
    changePassword.mockReset().mockResolvedValue(undefined);
  });

  it("refuses an oversized newPassword (129 chars) with a 400, never reaching authService.changePassword", async () => {
    const res = await postChangePassword({
      currentPassword: "correct-horse",
      newPassword: "a".repeat(129),
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("accepts a newPassword right at the 128-character boundary", async () => {
    authenticateAccessToken.mockReset().mockResolvedValue({ userId: "u1", username: "admin" });
    changePassword.mockReset().mockResolvedValue(undefined);

    const res = await postChangePassword({
      currentPassword: "correct-horse",
      newPassword: "a".repeat(128),
    });

    expect(changePassword).toHaveBeenCalledWith("u1", "correct-horse", "a".repeat(128));
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it("still accepts an ordinary short newPassword (regression, unaffected by the new check)", async () => {
    authenticateAccessToken.mockReset().mockResolvedValue({ userId: "u1", username: "admin" });
    changePassword.mockReset().mockResolvedValue(undefined);

    const res = await postChangePassword({
      currentPassword: "correct-horse",
      newPassword: "newpassword123",
    });

    expect(changePassword).toHaveBeenCalledWith("u1", "correct-horse", "newpassword123");
    expect(res.status).not.toHaveBeenCalledWith(400);
  });
});
