import { designScale } from '../video/videoLayer.ts';
import type { DeviceInfo } from '../screens/settingsLogic.ts';

interface Globals {
  tizen?: { systeminfo?: { getCapability(key: string): unknown } };
  webapis?: { productinfo?: { getRealModel(): unknown } };
}

/** Reads display and engine facts for Diagnostics. Every platform call is wrapped: a missing API leaves a field out. */
export function readDeviceInfo(): DeviceInfo {
  const g = globalThis as unknown as Globals;
  const info: DeviceInfo = {};
  try {
    info.innerWidth = window.innerWidth;
    info.innerHeight = window.innerHeight;
    info.devicePixelRatio = window.devicePixelRatio;
    info.designScale = designScale();
    info.userAgent = navigator.userAgent;
    info.screenWidth = screen.width;
    info.screenHeight = screen.height;
    const canvas = document.querySelector<HTMLCanvasElement>('#app canvas');
    if (canvas) {
      info.renderWidth = canvas.width;
      info.renderHeight = canvas.height;
    }
  } catch { /* partial info is fine */ }
  try {
    const v = g.tizen?.systeminfo?.getCapability('http://tizen.org/feature/platform.version');
    if (typeof v === 'string') info.tizenPlatformVersion = v;
  } catch { /* not Tizen, or the call failed: the Engine line still has the user-agent Tizen version */ }
  try {
    const m = g.webapis?.productinfo?.getRealModel();
    if (typeof m === 'string') info.tizenModel = m;
  } catch { /* privilege or API missing */ }
  return info;
}
