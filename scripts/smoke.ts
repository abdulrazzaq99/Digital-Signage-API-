/**
 * End-to-end smoke test against a running stack (default http://localhost:4000):
 * health → login → pair a screen → connect the player socket → publish a playlist →
 * assert the player receives screen.assignment.updated and the manifest reflects it.
 * Usage: npx tsx scripts/smoke.ts [baseUrl]
 */
import { io } from "socket.io-client";

const base = process.argv[2] ?? "http://localhost:4000";
const api = `${base}/api/v1`;

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string>) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`${api}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message: string } };
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${body.error?.code ?? ""} ${body.error?.message ?? ""}`);
  return body.data as T;
}

function step(label: string) {
  console.log(`\n→ ${label}`);
}

async function main() {
  step("health");
  const health = (await (await fetch(`${base}/health`)).json()) as { status: string };
  console.log(health);
  if (health.status !== "ok") throw new Error("health is not ok");

  step("login as customer Admin (seeded)");
  const login = await call<{ accessToken: string; user: { companyId: string; name: string } }>("/auth/login", { method: "POST", body: JSON.stringify({ email: "sarah.mitchell@acmecorp.com", password: "Customer123!" }) });
  const token = login.accessToken;
  console.log(`signed in as ${login.user.name}`);

  step("player requests a pairing code");
  const session = await call<{ sessionId: string; code: string }>("/player/pairing-sessions", { method: "POST", body: JSON.stringify({ deviceId: `SMOKE-${Date.now()}`, model: "Android Box Pro", playerVersion: "1.6.3" }) });
  console.log(`code ${session.code}`);

  step("user pairs the screen");
  const screen = await call<{ id: string; name: string }>("/screens/pair", { method: "POST", token, body: JSON.stringify({ code: session.code, name: `Smoke Screen ${new Date().toISOString().slice(11, 19)}`, location: "Test bench" }) });
  const paired = await call<{ status: string; credential: string }>(`/player/pairing-sessions/${session.sessionId}`);
  if (paired.status !== "PAIRED" || !paired.credential) throw new Error("credential not issued");
  console.log(`paired ${screen.name}`);

  step("player connects to /player and waits for assignment events");
  const socket = io(`${base}/player`, { auth: { token: paired.credential }, transports: ["websocket"] });
  await new Promise<void>((resolve, reject) => { socket.on("connect", () => resolve()); socket.on("connect_error", (e) => reject(new Error(`socket: ${e.message}`))); });
  const assignment = new Promise<{ version: number }>((resolve) => socket.on("screen.assignment.updated", resolve));

  step("publish the seeded 'Summer Offers' playlist to the new screen");
  const playlists = await call<{ id: string; name: string }[]>("/playlists?search=Summer", { token });
  const playlist = playlists[0];
  if (!playlist) throw new Error("seeded playlist missing");
  const result = await call<{ version: number }>(`/playlists/${playlist.id}/publish`, { method: "POST", token, headers: { "Idempotency-Key": `smoke-${Date.now()}` }, body: JSON.stringify({ screenIds: [screen.id] }) });
  console.log(`published version ${result.version}`);

  const event = await Promise.race([assignment, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no screen.assignment.updated within 5 s")), 5000))]);
  console.log(`player received screen.assignment.updated v${event.version}`);

  step("player fetches the manifest and acknowledges");
  const manifest = await call<{ version: number; assignment: { name: string }; assets: { url: string }[] }>("/player/manifest", { token: paired.credential });
  if (manifest.assignment?.name !== playlist.name) throw new Error("manifest does not reflect the publish");
  console.log(`manifest v${manifest.version}: ${manifest.assignment.name}, ${manifest.assets.length} assets`);
  await fetch(`${api}/player/sync-ack`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${paired.credential}` }, body: JSON.stringify({ version: manifest.version, status: "activated" }) });
  const detail = await call<{ syncState: string; status: string }>(`/screens/${screen.id}`, { token });
  console.log(`screen is ${detail.status}, sync ${detail.syncState}`);

  step("cleanup: unpair");
  await fetch(`${api}/screens/${screen.id}/unpair`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  socket.close();
  console.log("\n✔ smoke test passed");
}

main().catch((err) => {
  console.error(`\n✘ ${(err as Error).message}`);
  process.exit(1);
});
