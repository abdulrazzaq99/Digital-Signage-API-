/**
 * Demo seed. Mirrors the sample content used by the web dashboards so the UI can be
 * wired to real endpoints with no visual change. Idempotent: re-running upserts.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
import { PrismaClient } from "../src/generated/prisma/client.js";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });

const SUPER_ADMIN_PASSWORD = "Admin123!";
const CUSTOMER_PASSWORD = "Customer123!";

async function main(): Promise<void> {
  const adminHash = await argon2.hash(SUPER_ADMIN_PASSWORD);
  const customerHash = await argon2.hash(CUSTOMER_PASSWORD);

  // ---- Super Admin ----
  await prisma.user.upsert({
    where: { email: "admin@dsp.local" },
    update: {},
    create: { email: "admin@dsp.local", name: "Alex Rivera", passwordHash: adminHash, platformRole: "SUPER_ADMIN", title: "Super Admin" },
  });

  // ---- Companies + licenses (admin panel sample data) ----
  const companies = [
    { code: "00001", name: "Acme Retail", status: "ACTIVE", license: "ACTIVE", limit: 20 },
    { code: "00002", name: "City Mall", status: "ACTIVE", license: "ACTIVE", limit: 50 },
    { code: "00003", name: "Fresh Bites", status: "ACTIVE", license: "ACTIVE", limit: 10 },
    { code: "00004", name: "Green Eats Co.", status: "INACTIVE", license: "DISABLED", limit: 4 },
    { code: "00005", name: "Harbor Clinic", status: "SUSPENDED", license: "SUSPENDED", limit: 8 },
    { code: "00006", name: "Metro Fashion", status: "ACTIVE", license: "ACTIVE", limit: 15 },
    { code: "00007", name: "Skyline Gym", status: "ACTIVE", license: "EXPIRED", limit: 12 },
    { code: "00008", name: "Sunrise Hotels", status: "ACTIVE", license: "ACTIVE", limit: 5 },
    { code: "00009", name: "Acme Corp", status: "ACTIVE", license: "ACTIVE", limit: 10, website: "https://acmecorp.com", phone: "+44 20 7946 0000", plan: "Platform Pro" },
  ] as const;

  const byCode: Record<string, string> = {};
  for (const c of companies) {
    const row = await prisma.company.upsert({
      where: { code: c.code },
      update: { name: c.name, status: c.status },
      create: { code: c.code, name: c.name, status: c.status, website: "website" in c ? c.website : undefined, phone: "phone" in c ? c.phone : undefined, plan: "plan" in c ? c.plan : undefined, timezone: "Europe/London" },
    });
    byCode[c.code] = row.id;
    await prisma.license.upsert({ where: { companyId: row.id }, update: { screenLimit: c.limit, state: c.license }, create: { companyId: row.id, screenLimit: c.limit, state: c.license } });
  }

  // ---- Acme Corp users (customer portal sample data) ----
  const acme = byCode["00009"]!;
  const users = [
    { email: "sarah.mitchell@acmecorp.com", name: "Sarah Mitchell", role: "ADMIN", title: "Marketing Director", phone: "+44 7700 900 147" },
    { email: "james.pearson@acmecorp.com", name: "James Pearson", role: "EDITOR" },
    { email: "lucy.chen@acmecorp.com", name: "Lucy Chen", role: "VIEWER" },
    { email: "marcus.webb@acmecorp.com", name: "Marcus Webb", role: "EDITOR", invited: true },
    { email: "emma.rodriguez@acmecorp.com", name: "Emma Rodriguez", role: "VIEWER", inactive: true },
  ] as const;
  const userIds: Record<string, string> = {};
  for (const u of users) {
    const row = await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, companyRole: u.role },
      create: { email: u.email, name: u.name, passwordHash: customerHash, platformRole: "CUSTOMER", companyRole: u.role, companyId: acme, title: "title" in u ? u.title : undefined, phone: "phone" in u ? u.phone : undefined, invitedAt: "invited" in u ? new Date() : undefined, isActive: !("inactive" in u) },
    });
    userIds[u.email] = row.id;
  }
  const sarah = userIds["sarah.mitchell@acmecorp.com"]!;

  // ---- Screens + groups ----
  const groups = [
    { name: "Lobby & Entrances", description: "All public-facing entrance and lobby displays." },
    { name: "Cafeteria Screens", description: "Food service and break room displays." },
    { name: "Warehouse & Safety", description: "Operational and safety notice screens." },
  ];
  const groupIds: Record<string, string> = {};
  for (const g of groups) {
    const row = await prisma.screenGroup.upsert({ where: { companyId_name: { companyId: acme, name: g.name } }, update: {}, create: { companyId: acme, ...g } });
    groupIds[g.name] = row.id;
  }

  const screens = [
    { name: "Reception Display", location: "Main Lobby, Floor 1", status: "ONLINE", group: "Lobby & Entrances", tags: ["lobby", "customer-facing"] },
    { name: "Lobby Display A", location: "East Entrance", status: "ONLINE", group: "Lobby & Entrances", tags: ["lobby"] },
    { name: "Cafeteria Screen", location: "Level 2, Break Room", status: "ONLINE", group: "Cafeteria Screens", tags: ["cafeteria"] },
    { name: "Conference Room B", location: "Level 3, Meeting Rooms", status: "OFFLINE", tags: ["meeting"] },
    { name: "Warehouse Display", location: "Loading Bay, Ground", status: "ONLINE", group: "Warehouse & Safety", tags: ["warehouse", "safety"] },
    { name: "Digital Menu Board", location: "Canteen Entrance", status: "ONLINE", group: "Cafeteria Screens", tags: ["cafeteria"] },
    { name: "Showroom Screen", location: "Customer Showroom", status: "ERROR", orientation: "PORTRAIT", tags: ["showroom"] },
    { name: "Exit Signage", location: "North Exit", status: "ONLINE", group: "Lobby & Entrances", tags: ["exit"] },
  ] as const;
  const screenIds: Record<string, string> = {};
  for (const [i, s] of screens.entries()) {
    const deviceId = `ANDROID-ACME-${String(i + 1).padStart(3, "0")}`;
    const existing = await prisma.screenDevice.findUnique({ where: { deviceId } });
    const row = existing
      ? await prisma.screen.update({ where: { id: existing.screenId }, data: { name: s.name, status: s.status } })
      : await prisma.screen.create({
          data: {
            companyId: acme, name: s.name, location: s.location, status: s.status, orientation: "orientation" in s ? s.orientation : "LANDSCAPE", tags: [...s.tags],
            lastSeenAt: s.status === "ONLINE" ? new Date() : new Date(Date.now() - 4 * 3600_000),
            device: { create: { deviceId, model: "BrightSign XT1145", playerVersion: "1.6.3", appVersion: "2.4.0", firmware: "v8.5.42", resolution: "1920x1080", ip: `192.168.1.${101 + i}` } },
          },
        });
    screenIds[s.name] = row.id;
    if ("group" in s) await prisma.screenGroupMember.upsert({ where: { groupId_screenId: { groupId: groupIds[s.group]!, screenId: row.id } }, update: {}, create: { groupId: groupIds[s.group]!, screenId: row.id } });
  }

  // ---- Media ----
  const media = [
    { key: "seed/summer-promo-hero.jpg", name: "Summer_Promo_Hero.jpg", type: "IMAGE", mime: "image/jpeg", size: 2_400_000, status: "READY", width: 1920, height: 1080, tags: ["promotion", "summer"] },
    { key: "seed/brand-refresh-banner.png", name: "Brand_Refresh_Banner.png", type: "IMAGE", mime: "image/png", size: 1_800_000, status: "READY", width: 1920, height: 1080, tags: ["brand"] },
    { key: "seed/product-showcase-loop.mp4", name: "Product_Showcase_Loop.mp4", type: "VIDEO", mime: "video/mp4", size: 46_200_000, status: "READY", duration: 45, tags: ["product"] },
    { key: "seed/daily-menu-board.jpg", name: "Daily_Menu_Board.jpg", type: "IMAGE", mime: "image/jpeg", size: 3_100_000, status: "READY", width: 1920, height: 1080, tags: ["menu"] },
    { key: "seed/safety-procedures-guide.pdf", name: "Safety_Procedures_Guide.pdf", type: "PDF", mime: "application/pdf", size: 5_600_000, status: "READY", pages: 8, tags: ["safety"] },
    { key: "seed/acme-intro-video.mp4", name: "Acme_Intro_Video.mp4", type: "VIDEO", mime: "video/mp4", size: 112_400_000, status: "PROCESSING", duration: 130, tags: [] },
    { key: "seed/q3-corporate-report.pdf", name: "Q3_Corporate_Report.pdf", type: "PDF", mime: "application/pdf", size: 8_200_000, status: "FAILED", pages: 24, tags: [], failure: "Unsupported PDF encryption" },
    { key: "seed/lobby-welcome-slide.png", name: "Lobby_Welcome_Slide.png", type: "IMAGE", mime: "image/png", size: 900_000, status: "READY", width: 1920, height: 1080, tags: ["lobby"] },
  ] as const;
  const mediaIds: Record<string, string> = {};
  for (const m of media) {
    const row = await prisma.mediaAsset.upsert({
      where: { storageKey: m.key },
      update: { status: m.status },
      create: { companyId: acme, name: m.name, type: m.type, status: m.status, mimeType: m.mime, sizeBytes: BigInt(m.size), storageKey: m.key, width: "width" in m ? m.width : undefined, height: "height" in m ? m.height : undefined, durationSec: "duration" in m ? m.duration : undefined, pages: "pages" in m ? m.pages : undefined, tags: [...m.tags], failureReason: "failure" in m ? m.failure : undefined, uploadedById: sarah },
    });
    mediaIds[m.name] = row.id;
  }

  // ---- Playlists ----
  const playlists = [
    { name: "Summer Offers", status: "PUBLISHED", items: [["Summer_Promo_Hero.jpg", 15], ["Product_Showcase_Loop.mp4", 45], ["Lobby_Welcome_Slide.png", 10], ["Brand_Refresh_Banner.png", 12], ["Daily_Menu_Board.jpg", 10], ["Summer_Promo_Hero.jpg", 10]] },
    { name: "Daily Menu", status: "PUBLISHED", items: [["Daily_Menu_Board.jpg", 20], ["Product_Showcase_Loop.mp4", 45], ["Summer_Promo_Hero.jpg", 10]] },
    { name: "Safety & Operations", status: "DRAFT", items: [["Safety_Procedures_Guide.pdf", 25], ["Brand_Refresh_Banner.png", 15]] },
  ] as const;
  const playlistIds: Record<string, string> = {};
  for (const p of playlists) {
    const existing = await prisma.playlist.findFirst({ where: { companyId: acme, name: p.name } });
    const row = existing ?? (await prisma.playlist.create({ data: { companyId: acme, name: p.name, status: p.status, version: p.status === "PUBLISHED" ? 1 : 0 } }));
    playlistIds[p.name] = row.id;
    if (!existing) {
      await prisma.playlistItem.createMany({ data: p.items.map(([asset, dur], i) => ({ playlistId: row.id, position: i, assetId: mediaIds[asset]!, durationSec: dur })) });
    }
  }
  for (const [screen, playlist] of [["Reception Display", "Summer Offers"], ["Lobby Display A", "Summer Offers"], ["Cafeteria Screen", "Daily Menu"], ["Digital Menu Board", "Daily Menu"]] as const) {
    await prisma.screenAssignment.upsert({ where: { screenId: screenIds[screen]! }, update: {}, create: { screenId: screenIds[screen]!, kind: "PLAYLIST", refId: playlistIds[playlist]!, version: 1, publishedById: sarah } });
    await prisma.screen.update({ where: { id: screenIds[screen]! }, data: { manifestVersion: 1, ackVersion: 1 } });
  }

  // ---- Layout presets (global) ----
  const presets: { id: string; name: string; zones: [string, number, number, number, number][] }[] = [
    { id: "full-screen", name: "Full Screen", zones: [["Main Zone", 0, 0, 1, 1]] },
    { id: "main-sidebar", name: "Main + Sidebar", zones: [["Main Content", 0, 0, 0.7, 1], ["Sidebar", 0.7, 0, 0.3, 1]] },
    { id: "main-bottom-bar", name: "Main + Bottom Bar", zones: [["Main Content", 0, 0, 1, 0.75], ["Bottom Bar", 0, 0.75, 1, 0.25]] },
    { id: "split-screen", name: "Split Screen", zones: [["Left", 0, 0, 0.5, 1], ["Right", 0.5, 0, 0.5, 1]] },
    { id: "main-two-side", name: "Main + Two Side Zones", zones: [["Main Content", 0, 0, 0.68, 1], ["Side Top", 0.68, 0, 0.32, 0.5], ["Side Bottom", 0.68, 0.5, 0.32, 0.5]] },
  ];
  for (const p of presets) {
    const existing = await prisma.layout.findFirst({ where: { isPreset: true, presetId: p.id } });
    if (!existing) {
      await prisma.layout.create({ data: { presetId: p.id, name: p.name, isPreset: true, zones: { create: p.zones.map(([name, x, y, w, h], index) => ({ index, name, x, y, w, h })) } } });
    }
  }

  // ---- Templates (global) ----
  const templates = [
    { name: "Flash Sale", category: "Retail", fields: [{ key: "headline", label: "Headline", type: "text", required: true, max: 30 }, { key: "discount", label: "Discount", type: "text", required: true, max: 20 }, { key: "was", label: "Original Price", type: "text", required: true, max: 15 }, { key: "now", label: "Sale Price", type: "text", required: true, max: 15 }, { key: "image", label: "Product Image", type: "image", required: false }] },
    { name: "Event Announcement", category: "Corporate", fields: [{ key: "kicker", label: "Kicker", type: "text", max: 30 }, { key: "title", label: "Event Title", type: "text", required: true, max: 60 }, { key: "date", label: "Date", type: "text", required: true, max: 40 }, { key: "time", label: "Time", type: "text", required: true, max: 40 }] },
    { name: "Happy Hour", category: "Food & Beverage", fields: [{ key: "title", label: "Title", type: "text", required: true, max: 30 }, { key: "start", label: "Start Time", type: "text", required: true, max: 10 }, { key: "end", label: "End Time", type: "text", required: true, max: 10 }] },
  ];
  for (const t of templates) {
    const existing = await prisma.template.findFirst({ where: { name: t.name, isGlobal: true } });
    if (!existing) await prisma.template.create({ data: { name: t.name, category: t.category, fields: t.fields, isGlobal: true } });
  }

  // ---- Offers ----
  const contact = { name: "James Whitfield", role: "Account Manager", email: "j.whitfield@signageplatform.com", phone: "+44 20 7946 0112" };
  const offers = [
    { title: "Commercial Display Upgrade Programme", category: "Hardware", summary: "Trade in your existing screens and upgrade to 4K commercial-grade displays at preferential pricing.", included: ["4K UHD · 500 nit brightness", "24/7 continuous operation rating", "3-year on-site warranty", "Trade-in credit available"], steps: ["Contact your account manager to request a site assessment and trade-in valuation.", "Your account manager will send a formal quotation within 2 business days.", "Confirm your order and arrange a convenient installation date.", "Our certified engineers will install and configure your new displays."] },
    { title: "ProPlayer 4 Media Player Bundle", category: "Hardware", summary: "Get our latest 4K media player pre-configured for your account, with three months of priority support included.", included: ["4K60 HDR output", "Pre-paired to your account", "Mounting kit and cabling", "3 months priority support"], steps: ["Tell your account manager how many players you need.", "Receive a quotation within 2 business days.", "Confirm and choose delivery dates per site.", "Plug in, power on, and your content plays."] },
    { title: "Platform Pro — Upgrade Offer", category: "Software", summary: "Unlock advanced scheduling, analytics dashboards, and multi-site management at a preferential renewal rate.", endsAt: "2026-10-15", included: ["Advanced scheduling", "Analytics dashboards", "10 additional user seats", "Multi-site management"], steps: ["Request an upgrade quotation from your account manager.", "Review the 24-month preferential terms.", "Confirm and we switch your account the same day."] },
    { title: "Professional Content Creation Service", category: "Services", summary: "Have our design studio produce a full set of on-brand signage templates and animated creatives for your locations.", included: ["Brand-matched templates", "Animated loops", "Seasonal refresh", "Unlimited revisions in scope"], steps: ["Share your brand guidelines with your account manager.", "Receive a creative proposal and quotation.", "Approve concepts and receive production files.", "Templates appear in your Layouts / Templates library."] },
    { title: "Extended Warranty & Priority Support", category: "Support", summary: "Extend hardware warranty coverage and gain access to a priority support line with guaranteed 4-hour response times.", included: ["5-year hardware coverage", "Advance replacement", "Priority support line", "4-hour response SLA"], steps: ["Request a coverage quotation for your paired devices.", "Review the coverage schedule.", "Confirm and coverage starts immediately."] },
    { title: "Multi-Site Network Assessment", category: "Services", summary: "A free professional audit of your screen network to identify performance gaps and optimisation opportunities.", endsAt: "2026-09-30", included: ["Network topology review", "Player health audit", "Content delivery analysis", "Written recommendations"], steps: ["Book an assessment slot through your account manager.", "Provide site access details.", "Receive your report within 5 business days."] },
  ] as const;
  for (const o of offers) {
    const existing = await prisma.offer.findFirst({ where: { title: o.title } });
    if (!existing) {
      await prisma.offer.create({ data: { title: o.title, category: o.category, status: "PUBLISHED", summary: o.summary, description: o.summary, instructions: o.steps.join(" "), contact, included: [...o.included], steps: [...o.steps], publishedAt: new Date("2026-06-03"), startsAt: new Date("2026-06-03"), endsAt: "endsAt" in o ? new Date(o.endsAt) : undefined } });
    }
  }

  // ---- Scratch campaign ----
  const existingCampaign = await prisma.scratchCampaign.findFirst({ where: { title: "Summer Rewards Draw" } });
  if (!existingCampaign) {
    const campaign = await prisma.scratchCampaign.create({
      data: {
        title: "Summer Rewards Draw", description: "Scratch and reveal your instant prize. One chance per eligible Acme Corp account — prizes allocated by our team.",
        status: "ACTIVE", startsAt: new Date("2026-06-01"), endsAt: new Date("2026-09-30"), maxAttempts: 1, requireOffersVisit: false,
        allocation: { loseWeight: 40 },
        prizes: { create: [{ name: "ProPlayer 4 Media Bundle", value: "£640", quantity: 3, remaining: 3 }, { name: "6-Month Platform Pro Upgrade", value: "£480", quantity: 10, remaining: 10 }, { name: "Professional Content Pack", value: "£320", quantity: 25, remaining: 25 }] },
      },
      include: { prizes: true },
    });
    await prisma.scratchCampaign.update({ where: { id: campaign.id }, data: { allocation: { loseWeight: 40, prizes: campaign.prizes.map((p, i) => ({ prizeId: p.id, weight: [5, 15, 40][i] })) } } });
  }

  // ---- Activity ----
  if ((await prisma.activityLog.count({ where: { companyId: acme } })) === 0) {
    await prisma.activityLog.createMany({
      data: [
        { companyId: acme, actorId: sarah, action: "playlist.published", resourceType: "playlist", resourceId: playlistIds["Summer Offers"], summary: '"Summer Offers" published to Reception Display' },
        { companyId: acme, action: "screen.offline", resourceType: "screen", resourceId: screenIds["Conference Room B"], status: "FAILED", summary: "Conference Room B went offline" },
        { companyId: acme, actorId: sarah, action: "media.uploaded", resourceType: "media", summary: "3 images added to Media Library" },
        { companyId: acme, actorId: sarah, action: "schedule.updated", resourceType: "schedule", summary: "Daily Menu schedule updated for Cafeteria Screen" },
        { companyId: acme, actorId: sarah, action: "screen.paired", resourceType: "screen", resourceId: screenIds["Exit Signage"], summary: "Exit Signage paired to your account" },
      ],
    });
  }

  console.warn("Seed complete. Super Admin: admin@dsp.local / Admin123! · Customer: sarah.mitchell@acmecorp.com / Customer123!");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
