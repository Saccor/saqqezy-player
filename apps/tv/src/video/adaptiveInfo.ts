export interface PanelCaps {
  uhd: boolean;
  eightK: boolean;
  hdrTv: boolean;
  avplayVersion?: string;
  /** Which of the booleans above an API actually answered (true or false); absent = nothing is known. */
  answered?: { uhd?: boolean; eightK?: boolean; hdrTv?: boolean };
}

/**
 * AVPlay ADAPTIVE_INFO (IDLE only, one call: a second call may overwrite the first). `max1080`: a multiview window on
 * the SUB scaler, which is not documented for UHD.
 */
export function adaptiveInfo(p: PanelCaps, o: { max1080?: boolean } = {}): string {
  const keys = ['STARTBITRATE=LOWEST'];
  if (o.max1080) keys.push('FIXED_MAX_RESOLUTION=1920X1080');
  else if (p.eightK) keys.push('FIXED_MAX_RESOLUTION=7680X4320');
  else if (p.uhd) keys.push('FIXED_MAX_RESOLUTION=3840X2160');
  return keys.join('|');
}
