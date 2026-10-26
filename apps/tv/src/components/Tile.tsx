import { Show, View, type ElementNode, type JSX } from '@lightningtv/solid';
import { Match, Switch } from 'solid-js';
import type { EpisodeView, VodTile } from '@iptv/app-api';
import { useFocusScale } from '../shell/motion.ts';
import { COLORS, RADIUS, TYPE } from '../shell/theme.ts';
import { PosterArt } from '../vod/PosterArt.tsx';
import { FocusRing } from './FocusRing.tsx';
import { EpisodeText } from './tile/EpisodeBody.tsx';
import { LogoBody } from './tile/LogoBody.tsx';
import { CompactBody, FullBody } from './tile/WideBody.tsx';
import { tileRowHeight, tileSize, type TileVariant } from './tileLogic.ts';
import { wideLines, type WideCell } from './wideTileLogic.ts';

interface TileBase { x: number; y: number; lit: boolean; hover?: boolean; ref?: (el: ElementNode) => void }
export type PosterTileProps = TileBase & { variant: 'poster'; tile: VodTile | undefined; label?: string; w?: number; h?: number };
export type WideTileProps = TileBase & { variant: 'wide' | 'wideCompact'; cell: WideCell; now: number; channelNumbers?: boolean; detail?: string };
export type EpisodeTileProps = TileBase & { variant: 'episode'; ep: EpisodeView | undefined };
export type ChipTileProps = TileBase & { variant: 'chip'; w?: number; h?: number; children: JSX.Element };
export type LogoTileProps = TileBase & { variant: 'logo'; url: string | undefined; name: string; size?: number };
export type TileProps = PosterTileProps | WideTileProps | EpisodeTileProps | ChipTileProps | LogoTileProps;

const sizeOf = (p: TileProps) => {
  if (p.variant === 'poster') return tileSize('poster', { w: p.w, h: p.h });
  if (p.variant === 'wideCompact') return tileSize('wideCompact', { detail: p.detail !== undefined });
  if (p.variant === 'chip') return tileSize('chip', { w: p.w, h: p.h });
  if (p.variant === 'logo') return tileSize('logo', { w: p.size, h: p.size });
  return tileSize(p.variant as TileVariant);
};

/**
 * One tile (spec 2026-10-26 §1.3): a scaled art area with the shared FocusRing (scale 1.05 + 4 px ring at 4 px offset)
 * and a variant body. Episode tiles add their text lines below the art, outside the scale. Not focusable: the row or
 * screen owns the keys.
 */
export function Tile(props: TileProps) {
  const s = () => sizeOf(props);
  let art: ElementNode | undefined;
  useFocusScale(() => art, () => props.lit);
  const wideImage = (c: WideCell) => (c.type === 'channel' ? c.channel.logo : c.type === 'event' ? c.event.icon : c.type === 'programme' ? c.hit.channel.logo : undefined);
  return (
    <View x={props.x} y={props.y} width={s().w} height={tileRowHeight(props.variant, s().h)} zIndex={props.lit ? 2 : 1}>
      <View ref={(el) => { art = el; props.ref?.(el); }} width={s().w} height={s().h} zIndex={1}>
        <FocusRing w={s().w} h={s().h} radius={RADIUS.card} lit={props.lit} hover={props.hover} />
        <Switch>
          <Match when={props.variant === 'poster' ? (props as PosterTileProps) : undefined}>{(p) => (
            <PosterArt w={s().w} h={s().h} title={p().tile?.title ?? ''} image={p().tile?.poster} progress={p().tile?.progress}
              lit={props.lit} label={p().label} pending={!p().tile && p().label === undefined} titleLines={2} titleFont={TYPE.body} />
          )}</Match>
          <Match when={props.variant === 'wide' || props.variant === 'wideCompact' ? (props as WideTileProps) : undefined}>{(p) => {
            const lines = () => wideLines(p().cell, p().now, p().channelNumbers, p().variant === 'wideCompact');
            /** On-now programmes show how far along they are. */
            const onAir = () => { const c = p().cell; return c.type === 'programme' && c.when === 'onNow' ? c.hit : undefined; };
            return (
              <>
                <View width={s().w} height={s().h} zIndex={1} color={COLORS.surface} borderRadius={RADIUS.card} />
                <Show when={p().variant === 'wideCompact'} fallback={
                  <FullBody image={wideImage(p().cell)} context={lines().context} main={lines().main} onAir={onAir()} now={p().now} />
                }>
                  <CompactBody image={wideImage(p().cell)} context={lines().context} main={lines().main} sides={lines().sides}
                    detail={p().detail} live={lines().live} h={s().h} />
                </Show>
              </>
            );
          }}</Match>
          <Match when={props.variant === 'episode' ? (props as EpisodeTileProps) : undefined}>{(p) => (
            <Show when={p().ep} fallback={<View width={s().w} height={s().h} borderRadius={RADIUS.card} color={COLORS.surface} />}>
              <PosterArt w={s().w} h={s().h} title={p().ep?.title ?? ''} image={p().ep?.still} watched={p().ep?.watched}
                progress={p().ep?.watched ? undefined : p().ep?.progress} lit={props.lit} titleFont={TYPE.body} titleLines={2} titleBottom={96} />
            </Show>
          )}</Match>
          <Match when={props.variant === 'chip' ? (props as ChipTileProps) : undefined}>{(p) => (
            <View width={s().w} height={s().h} zIndex={1} borderRadius={RADIUS.card} color={COLORS.surface}>{p().children}</View>
          )}</Match>
          <Match when={props.variant === 'logo' ? (props as LogoTileProps) : undefined}>{(p) => (
            <LogoBody url={p().url} name={p().name} size={s().w} />
          )}</Match>
        </Switch>
      </View>
      <Show when={props.variant === 'episode' ? (props as EpisodeTileProps) : undefined}>{(p) => <EpisodeText ep={p().ep} />}</Show>
    </View>
  );
}
