import type { DrawerId } from '../store/store';

/** Drawer widths (px), shared by the drawers and the 3D camera framing. */
export const DRAWER_WIDTHS: Record<DrawerId, number> = {
  account: 560,
  positions: 560,
  orders: 560,
  risk: 560,
  trade: 480,
  journal: 560,
  health: 480,
  settings: 640,
  audit: 640,
  live: 560,
};

export const WORKER_DESK_WIDTH = 640;

/** Desktop overlay geometry around the city (see App.tsx DesktopLayout). */
export const DESKTOP_PANELS = { left: 288 + 12, right: 340 + 12, bottom: 212 };
