export interface PanelCaps {
  uhd: boolean;
  eightK: boolean;
  hdrTv: boolean;
  avplayVersion?: string;
  /** Which of the booleans above an API actually answered (true or false); absent = nothing is known. */
  answered?: { uhd?: boolean; eightK?: boolean; hdrTv?: boolean };
}

/** AVPlay ADAPTIVE_INFO (IDLE only, one call: a second call may overwrite the first). */
export function adaptiveInfo(p: PanelCaps): string {
  const keys = ['STARTBITRATE=LOWEST'];
  if (p.eightK) keys.push('FIXED_MAX_RESOLUTION=7680X4320');
  else if (p.uhd) keys.push('FIXED_MAX_RESOLUTION=3840X2160');
  return keys.join('|');
}
