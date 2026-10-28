/**
 * Movies or Series browse's reads: the home (its rows), the categories (apart, on their own ticket), and the items of
 * the rows on screen. Every load and source change starts a new generation; answers from an older one are dropped.
 * Not unit-tested: the pure rules live in browseLogic.ts.
 */
import { batch } from 'solid-js';
import type { VodCategoryView, VodHome } from '@iptv/app-api';
import { VOD_ROW_ITEMS } from '@iptv/app-api';
import { api } from '../../api.ts';
import { catsReloadNeeded, createTicket, locateFocus, mergeRows, rowSort, rowsToLoad, toRowModels } from '../../vod/browseLogic.ts';
import type { BrowseState } from './createBrowseState.ts';

/** What the screen showed before a load (focus may need to move once the load mounts or unmounts the focused view). */
export interface BrowseShown { status: string | undefined; hasRows: boolean; hasHeader: boolean }

export function createBrowseData(st: BrowseState, d: {
  alive: () => boolean;
  /** After a load: focus back on what the user chose, when the load may have unmounted the focused view. */
  restoreFocus: (before: BrowseShown) => void;
  /** The strip's detail follows the dwelled title (`createBrowseHero`). */
  syncHero: () => void;
}) {
  const { kind, copy, rows, focus, status, hasHeader } = st;
  const { alive } = d;
  const loading = new Set<string>();
  /** Bumped by every load and source change; results from an older generation are dropped. */
  let gen = 0;

  // Its own ticket: a home-only poll must never drop a category request in flight.
  const catTickets = createTicket();
  const loadCats = async () => {
    const t = catTickets.next();
    let cs: VodCategoryView[];
    try {
      cs = await api.getVodCategories(kind);
    } catch {
      return; // The header keeps what it had.
    }
    if (!alive() || !catTickets.isCurrent(t)) return;
    const before = { status: status(), hasRows: rows().length > 0, hasHeader: hasHeader() };
    st.setCats(cs);
    d.restoreFocus(before);
  };

  /** `withCats` false re-reads only the home (the stuck-loading poll). */
  const load = async (withCats = true) => {
    const g = ++gen;
    if (withCats) void loadCats();
    const before = { status: status(), hasRows: rows().length > 0, hasHeader: hasHeader() };
    let h: VodHome | undefined;
    try {
      h = await api.getVodHome(kind);
    } catch (err) {
      if (!alive() || g !== gen) return;
      console.warn('VOD load failed', err instanceof Error ? err.name : 'Error');
      batch(() => {
        st.setHome({ status: 'error', rows: [], truncated: false, error: { name: 'Error', message: copy.loadError } });
        st.setRows([]);
      });
      d.restoreFocus(before);
      return;
    }
    if (!alive() || g !== gen) return;
    const models = mergeRows(rows(), toRowModels(h));
    // Rows above the focus come and go (Continue watching, Favourites): find the remembered row and poster again.
    batch(() => {
      st.setHome(h);
      st.setRows(models);
      st.setFocus(locateFocus(models, st.memory().focus));
    });
    if (catsReloadNeeded(before.status, h.status, withCats)) void loadCats();
    st.remember();
    d.syncHero();
    void loadNear();
    d.restoreFocus(before);
  };

  const loadNear = async () => {
    const g = gen;
    const rs = rows();
    // The rows on screen: the focused one, the next in full and a third peeking in.
    for (const i of rowsToLoad(rs, focus().row, 2)) {
      const r = rs[i]!;
      const key = `${g}:${r.id}`;
      if (loading.has(key)) continue;
      loading.add(key);
      try {
        const page = await api.getVodSlice(kind, r.id, rowSort(rs), 0, VOD_ROW_ITEMS);
        if (!alive()) return;
        if (g !== gen) { void loadNear(); return; }
        st.setRows((cur) => cur.map((x) => (x.id === r.id ? { ...x, items: page.rows, total: page.total, loaded: true, stale: false } : x)));
        if (r.id === st.memory().focus.rowId) {
          // The focused row's items arrived: put focus back on the remembered poster.
          st.setFocus(locateFocus(rows(), st.memory().focus));
          st.remember();
        }
      } catch {
        // Stays a loading cell; a later focus move tries again.
      } finally {
        loading.delete(key);
      }
    }
  };

  return {
    load, loadNear,
    /** A source change: every answer in flight is dropped. */
    restart: () => {
      gen++;
      loading.clear();
    },
  };
}
