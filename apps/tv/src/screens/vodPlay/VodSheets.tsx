/**
 * The VOD player's layers: the Subtitles picker, the Options sheet, the online subtitle and version pickers and the
 * link keyboard. Each is drawn while its part (`createVodTracks`, `createVodOptions`, `createSubtitleFinder`) says it
 * is open; those parts own the back layers and the focus.
 */
import { Show, View } from '@lightningtv/solid';
import { createMemo } from 'solid-js';
import { Keyboard, KEYBOARD_URL_H, KEYBOARD_W } from '../../components/Keyboard.tsx';
import { FULL_LAYOUT } from '../../components/keyboardLogic.ts';
import { Sheet } from '../../components/Sheet.tsx';
import { fromOptionItem, fromPickerRow } from '../../components/sheetLogic.ts';
import { PLAYER_COPY, SOURCE_COPY, VOD_COPY } from '../../copy.ts';
import { COLORS, LAYOUT } from '../../shell/theme.ts';
import type { LoadedSubtitleState } from './createLoadedSubtitle.ts';
import type { SubtitleFinder } from './createSubtitleFinder.ts';
import type { createVodOptions } from './createVodOptions.ts';
import type { createVodTracks } from './createVodTracks.ts';
import { SUB_ONLINE_ID, SUB_VERSIONS_ID, TRACKS_ID } from './layout.ts';

/** OpenSubtitles' free plan asks for this line wherever its subtitles are picked. */
const ONLINE_ATTRIBUTION = VOD_COPY.attribution;

export function VodSheets(props: {
  sub: LoadedSubtitleState;
  tracks: ReturnType<typeof createVodTracks>;
  options: ReturnType<typeof createVodOptions>;
  finder: SubtitleFinder;
}) {
  return (
    <>
      <Show when={props.tracks.pickerOpen()}>{(() => {
        const trackRows = createMemo(() => props.tracks.rows());
        const trackSheetRows = createMemo(() => trackRows().map(fromPickerRow));
        return (
          <Sheet ref={props.tracks.pickerRef} title={VOD_COPY.subtitles} rows={trackSheetRows()} backLayerId={TRACKS_ID}
            onSelect={(_, i) => { const r = trackRows()[i]; if (r) props.tracks.pickTrack(r); }}
            onAdjust={(_, i, d) => { const r = trackRows()[i]; return r ? props.sub.adjustRow(r, d) : false; }} />
        );
      })()}</Show>


      <Show when={props.options.optionsPage()} keyed>{(page) => {
        const optionRows = createMemo(() => props.options.optionItems().map(fromOptionItem));
        return (
          <Sheet ref={props.options.optionsRef}
            title={page === 'audio' ? PLAYER_COPY.audioTrack : page === 'source' ? SOURCE_COPY.choose : PLAYER_COPY.options}
            rows={optionRows()} onSelect={(r) => props.options.chooseOption(r.id)} scrim={false} swallow="player" zIndex={40} />
        );
      }}</Show>

      <Show when={props.finder.onlineRows()}>{(list) => {
        const onlineSheetRows = createMemo(() => list().map(fromPickerRow));
        return (
          <Sheet ref={props.finder.onlineRef} title={VOD_COPY.subtitlesOnline} rows={onlineSheetRows()} backLayerId={SUB_ONLINE_ID}
            onSelect={(_, i) => { const r = list()[i]; if (r) props.finder.pickOnline(r); }}
            footer={props.sub.subBusy() ? VOD_COPY.loadingSubtitles : ONLINE_ATTRIBUTION} />
        );
      }}</Show>

      <Show when={props.finder.versionPickRows()}>{(list) => {
        const versionSheetRows = createMemo(() => list().map(fromPickerRow));
        return (
          <Sheet ref={props.finder.versionsRef} title={VOD_COPY.subtitleVersions} rows={versionSheetRows()} backLayerId={SUB_VERSIONS_ID}
            onSelect={(_, i) => { const r = list()[i]; if (r) props.finder.pickVersion(r); }}
            footer={props.sub.subBusy() ? VOD_COPY.loadingSubtitles : ONLINE_ATTRIBUTION} />
        );
      }}</Show>

      <Show when={props.finder.linkText() !== undefined}>
        <View zIndex={40} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim}>
          <Keyboard ref={props.finder.keyboardRef} x={(LAYOUT.width - KEYBOARD_W) / 2} y={(LAYOUT.height - KEYBOARD_URL_H) / 2}
            layout={FULL_LAYOUT} label={VOD_COPY.subtitleLink} value={props.finder.linkText() ?? ''}
            onChange={props.finder.typeLink} onDone={() => void props.finder.submitLink()}
            hint={props.sub.subBusy() ? VOD_COPY.loadingSubtitles : undefined} error={props.finder.linkError()} />
        </View>
      </Show>
    </>
  );
}
