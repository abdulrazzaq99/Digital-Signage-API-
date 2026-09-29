import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SesMailProvider } from "./ses.js";

describe("SesMailProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the text and HTML parts from the configured sender", async () => {
    const send = vi.spyOn(SESv2Client.prototype, "send").mockResolvedValue({} as never);
    await new SesMailProvider("eu-north-1", "AddifyTv <no-reply@addifytv.nu>").send({ to: "sarah@acme.com", subject: "You're invited", text: "Hi Sarah", html: "<p>Hi Sarah</p>" });
    const cmd = send.mock.calls[0]?.[0] as SendEmailCommand;
    expect(cmd).toBeInstanceOf(SendEmailCommand);
    expect(cmd.input).toEqual({
      FromEmailAddress: "AddifyTv <no-reply@addifytv.nu>",
      Destination: { ToAddresses: ["sarah@acme.com"] },
      Content: { Simple: { Subject: { Data: "You're invited", Charset: "UTF-8" }, Body: { Text: { Data: "Hi Sarah", Charset: "UTF-8" }, Html: { Data: "<p>Hi Sarah</p>", Charset: "UTF-8" } } } },
    });
  });

  it("lets a failed send throw so the mail job retries", async () => {
    vi.spyOn(SESv2Client.prototype, "send").mockRejectedValue(new Error("MessageRejected"));
    await expect(new SesMailProvider("eu-north-1", "a@b.co").send({ to: "x@y.co", subject: "s", text: "t" })).rejects.toThrow("MessageRejected");
  });
});
