/** Real-time event names (spec 17.2). Server → Player, Player → Server, Server → App. */
export const Events = {
  assignmentUpdated: "screen.assignment.updated",
  scheduleUpdated: "screen.schedule.updated",
  remoteRefresh: "screen.remote.refresh",
  remoteRestart: "screen.remote.restart_player",
  presence: "screen.presence",
  syncAck: "screen.sync.ack",
  mediaReady: "media.ready",
  offerPublished: "offer.published",
  canvasActivate: "canvas.activate",
  /** Server → sender: a socket event was malformed or failed. `{ event, code, message, issues? }`. */
  socketError: "socket.error",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];
export const screenRoom = (screenId: string) => `screen:${screenId}`;
export const companyRoom = (companyId: string) => `company:${companyId}`;
export const platformRoom = "platform";
