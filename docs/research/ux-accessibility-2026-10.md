# Designing a live-TV player for everyone: UX, accessibility, onboarding, families, localisation (Oct 2026)

## 0. Method and confidence

- Sources: platform developer docs, Ofcom, Netflix help/release notes, TetraLogical, Amazon/Samsung/LG developer pages, EAA commentary. No providers, playlists or content sources were collected or linked.
- Several primary pages were unreachable (Apple HIG body, EUR-Lex Directive text, Ofcom report page returned 403, LG webOS docs, Lightning 3 docs, Titan OS docs). Items marked **[unverified]** come from third-party summaries or my own knowledge and must be checked on devices or primary text before they become specs.
- Direct evidence of demand for "simple mode" and for multilingual IPTV users is thin; I say so below rather than overstating.
- Not legal advice. The EAA section needs a lawyer's confirmation, the same as the project's other legal guardrails.

## 1. 10-foot UI: what the platforms say

**Google TV / Android TV.** Design on a 960x540 dp canvas and supply 1080p assets. Safe area is stated two ways on the same page: 48/24 dp (5%) in the calculation, 58 dp sides and 28 dp top/bottom in the recommended 12-column grid (52 dp columns, 20 dp gutters). Most modern TVs have no overscan problem but the guide still says keep key content inside. Reserve space for the focus scale-up so neighbours don't overlap. Align the focus path with the hierarchy; avoid many panels (cognitive load). The typography page defines a 15-style Roboto scale but gives no hard minimum: [layouts](https://developer.android.com/design/ui/tv/guides/styles/layouts), [typography](https://developer.android.com/design/ui/tv/guides/styles/typography).

**tvOS.** The Apple page did not load. Third-party digests of the HIG (not Apple) give: 60 pt safe inset (the "90 pt" figure I wanted to check was not confirmed; 80 pt side margins from my memory is **[unverified]**), minimum body 29 pt, secondary labels 25 pt, buttons 29-38 pt, focus scale about 1.05-1.1x plus shadow, "never rely on colour alone", cards at least about 250x150 pt: [summary](https://skills.cat/skills/ehmo/platform-design-skills/tvos-design-guidelines). Menu = back one level, never trap the user; respect Reduce Motion, Bold Text, Increase Contrast (HIG, **[unverified]**).

**Samsung Tizen.** The official guidance that matters is the TTS guide, covered in section 2. Samsung's own UX guideline page was not retrieved. Our CLAUDE.md already assumes overscan-safe layout.

**LG webOS.** No UX guideline fetched. Only one forum report (number inputs silent in Audio Guidance, section 2).

**TetraLogical TV best practices** (accessibility consultancy, covers BBC iPlayer-style apps) is the most concrete cross-platform source: [tv-best-practices](https://tetralogical.com/blog/2023/08/09/tv-best-practices/). Key points:
- Focus: a border or underline, not only a colour change; on dark backgrounds use a strong yellow-like indicator, on light a dark blue.
- WCAG 4.5:1 / 3:1 are a floor; TV adds distance, saturation and room lighting. Check icon contrast too. Never colour alone for status or selection.
- Offer text-size choices (iPlayer has five subtitle sizes). Do not auto-dismiss text; give a close button.
- Minimise motion; no flashing or endlessly repeating micro-animations.
- Reduce steps to content; logical directional navigation; shortcut keys (Play, Pause, Back, Menu, Close); support Bluetooth keyboards; voice only as an extra, never the only path.
- Captions and audio description must be findable through menus, filters and player controls, because many remotes lack CC/AD keys.
- Everything that carries visual meaning (menus, loading indicators, warnings, confirmations) must be announced.

**Netflix and BBC.** Netflix's release notes show that TV screen-reader quality is a continuous bug stream, not a one-off: fixes for rows ("Continue Watching"), missing speech on buttons and detail pages, stopping speech when the app is backgrounded, and AD/SDH badges on title pages with TTS ([release notes](https://help.netflix.com/en/node/119359)). Lesson: announce state changes, suppress speech when not foreground, surface access-service availability in lists. BBC: a case study argues accessibility must start at UX design, not as a final check ([Smashing](https://smashingmagazine.com/2015/02/bbc-iplayer-accessibility-case-study)); the GEL docs I found are web-only. No published TV-specific GEL focus spec found.

**Ofcom 2025 study of 30 over-65s** (DTG/i2 media research): ease of use drops sharply when moving from number-button channel selection to EPGs and on-demand menus; causes are complexity, unfamiliar terminology and inconsistent feedback, plus dexterity, vision and memory limits; a simplified prototype helped markedly ([Ofcom](https://www.ofcom.org.uk/internet-based-services/technology/identifying-challenges-and-solutions-for-improving-inclusivity-and-usability-in-the-consumption-of-internet-delivered-television); detail came via search summary, page itself returned 403).

**Derived rules for us**
- Body text >= 28 px-equivalent at 1080p (about 29 pt tvOS); never below 24 px for anything meaningful; user text-scale 100/125/150%.
- Safe margin: 5% (96 px side, 54 px top/bottom at 1080p) default; user-adjustable margin for old overscanning sets.
- Focus ring: 4 px, two-tone (light + dark) so it passes on any artwork, plus 1.05x scale. Always exactly one focused element.
- Navigation depth: player -> list -> settings, max 2 levels from the playing channel; BACK always one level.
- No timed auto-dismissal of anything except the info banner, and that duration is configurable (also WCAG 2.2.1).

## 2. Accessibility

### 2.1 Screen readers on each platform, and the canvas problem

| Platform | Mechanism | What the app must do |
|---|---|---|
| Samsung Tizen | Voice Guide (setting is system-level) reads name, role, description of the focused DOM element via ATK in the web engine. Needs `autofocus` on launch. Uses WAI-ARIA roles and `aria-label(ledby)`. | Real DOM elements with ARIA. [Samsung TTS guide](https://developer.samsung.com/tv/develop/guides/fundamentals/text-to-speech) |
| LG webOS | Audio Guidance; app declares `accessibility.supportsAudioGuidance: true` in `appinfo.json`. Reads `aria-label` on focus. A reported silent case: `input type=number` fixed by `role="textbox"` (single forum report). | DOM + ARIA + manifest flag. [LG forum](https://forum.webostv.developer.lge.com/t/audio-guidance-not-work-on-input-with-type-number/2391) |
| Android TV / Fire OS | TalkBack on native views (Kotlin/Media3): contentDescription, focus order, live regions. | Standard native accessibility. |
| tvOS | VoiceOver on native views (Swift later). | Standard. |
| Titan OS | TitanSDK exposes its own TTS "speak" call (docs said API in flux; page not fetched, via search snippet). | App speaks itself. [Titan docs](https://docs.titanos.tv/accessibility) |
| Desktop (Tauri) | WebView with OS screen reader (NVDA, VoiceOver) if DOM exists. | DOM + ARIA. |

**Key fact:** Samsung and LG screen readers read the DOM accessibility tree. A Lightning/WebGL canvas has none. A screen reader will announce nothing for a pure-canvas UI.

**Lightning Announcer.** The Lightning SDK (v5, Lightning 2) ships an Announcer that walks the focus path, collects strings or promises of strings from focused components, and sends them to a speech engine; default `speechSynthesis`, replaceable by overriding `Announcer._textToSpeech`; docs warn speechSynthesis "can randomly fail" ([docs](https://unpkg.com/@lightningjs/sdk@5.5.4/docs/plugins/accessibility/announcer.md)). I could not confirm a Lightning 3 / Blits / `@lightningjs/solid` equivalent. Comcast says it built accessibility into its LightningJS platform and intends to open-source components, no release found ([Comcast](https://corporate.comcast.com/stories/engineering-accessible-experiences-from-the-ground-up)). Also: `speechSynthesis` availability on Tizen/webOS TV browsers is **[unverified]**; the TV's own screen reader is a different pathway from an app speaking itself, and two voices at once is a known failure mode, so we must not double-speak when Voice Guide/Audio Guidance is active.

**Recommended architecture (hybrid):**
1. Keep Lightning for rendering. Add a hidden **DOM shadow tree** (visually-hidden, absolutely positioned, `aria-hidden` false) mirroring only the focusable elements: one node per focus target with role, accessible name, state, and `aria-live="polite"` region for dynamic text (now playing, errors). Move real DOM focus (`element.focus()`) in step with Lightning focus. This is the same pattern as Needle Engine's hidden DOM beside a canvas ([Needle](https://engine.needle.tools/docs/how-to-guides/accessibility)) and is what Samsung/LG screen readers can read. Needs real-device validation: it is the biggest risk.
2. Make the focus model a single store (SolidJS signal) that both the canvas and the DOM mirror subscribe to, so they can never diverge.
3. Virtualised lists: mirror only the focused row plus neighbours; announce "Channel 12, Channel name, now: Programme, 14 of 5,000" on focus, using `aria-posinset`/`aria-setsize` or a composed label.
4. Fallback speech layer (own TTS) for platforms with no screen reader on the DOM (Titan OS, possibly desktop): `speechSynthesis` or the platform SDK, enabled only when an in-app "Speak menus" toggle is on or the OS reports a reader.
5. Android/Apple native apps use native accessibility; do not port the DOM hack.

### 2.2 Visual
- **High contrast theme:** in-app (no documented web API reads the TV's High Contrast setting; Samsung's is a system menu theme). Target 7:1 text, 4.5:1 UI components in the HC theme, standard theme >= 4.5:1/3:1.
- **Large text:** scale tokens (100/125/150/200%) with layout reflow; test 200% on the EPG grid.
- **Colour-blind safe:** never encode state by hue alone (live/recorded/favourite/locked use shape + label). Don't map the four colour keys to meaning that is colour-only; show key labels with text. Prefer a blue/orange/white/black palette for focus and status (Okabe-Ito-like) **[my recommendation]**.
- **Reduced motion:** honour `prefers-reduced-motion` if the engine reports it, but the TV browsers' support is unverified; always provide an in-app "Reduce motion" (disable focus scale animation, row slides, parallax; keep instant focus change). No flashing.
- **Audio cues:** optional, never the only signal.

### 2.3 Subtitles, captions, audio description
- Sources in IPTV: CEA-608/708 embedded in H.264 SEI in MPEG-TS; DVB subtitles (bitmap) and DVB teletext as separate PIDs; WebVTT in HLS. Browsers' MSE does not render embedded 608/708; players must extract SEI and synthesise cues (mux.js does for MP4; TS handling in hls.js/mpegts.js **[unverified]**) ([mux.js captions](https://github.com/videojs/mux.js/blob/main/docs/captions.md), [Igalia](https://blogs.igalia.com/vwatermeier/cea-608-captions-in-media-source-extensions-with-webkitgtk/)). WebVTT has full Unicode; 608 is Latin-limited ([Uplynk](https://docs.uplynk.com/docs/captions-and-subtitles)).
- Tizen AVPlay: `getTotalTrackInfo()` (READY/PLAYING/PAUSED only), `setSelectTrack('TEXT', i)`, text delivered through `onsubtitlechange`, which we must render ourselves; external files only via local absolute path ([Samsung subtitles](https://developer.samsung.com/tv/develop/guides/multimedia/subtitles)). Rendering our own text lets us honour user style (size 5 steps, colour, background box, edge) — a requirement because bitmap DVB subs can't be restyled (offer scale/position only).
- Audio description appears as an extra audio track (language + "AD"/"description" flag). Our track picker must label it plainly ("Audio description") if the stream flags it (HLS CHARACTERISTICS `public.accessibility.describes-video`, DVB audio type) and surface it at the same level as CC.
- Remember per-channel/per-language choices; one-key access (a dedicated "Subtitles & audio" button in the player, reachable by D-pad when the remote lacks CC/AD keys).

### 2.4 European Accessibility Act (Directive 2019/882)
Applicable since 28 June 2025. Status of our questions:

- **Does it apply to a paid player app?** Likely yes, as a *service*. Commentary says that "access to audiovisual media services" includes websites, web apps, mobile apps and related **media players**, connected-TV services and EPGs; Annex I Section IV(b) additionally requires EPGs to be perceivable/operable/understandable/robust and to expose access-service availability, and access services (subtitles, AD, spoken subtitles, sign) to be transmitted complete, synchronised and user-controllable ([Digital Accessibility Centre](https://digitalaccessibilitycentre.org/blogs/AudioVisual-EAA.html), [Taylor Wessing](https://www.taylorwessing.com/en/interface/2025/media-hot-topics-2025/access-to-audiovisual-media-services-under-the-european-accessibility-act) via search summary; page returned 403). Commission overview lists AV media services, e-commerce, computers/OS: [Commission](https://commission.europa.eu/strategy-and-policy/policies/justice-and-fundamental-rights/disability/union-equality-strategy-rights-persons-disabilities-2021-2030/european-accessibility-act_en). A pure BYO-playlist player supplies *no* programmes of its own; whether it is an "audiovisual media service" under the AVMSD (a provider with editorial responsibility) is an open legal question **[needs lawyer]**. Our EPG and in-app purchase/licence flow (e-commerce) are the strongest hooks.
- **The EAA does not itself oblige anyone to produce captions/AD for content**; it obliges the *service* to carry and let users control them.
- **Microenterprise exemption:** services provided by a microenterprise (fewer than 10 staff and turnover or balance sheet <= EUR 2m, Art. 3(23)) are exempt from the service requirements, not from product rules; sources disagree whether both or either financial test must hold ([accessible.org](https://accessible.org/top-10-eaa-questions/), [Taylor Wessing](https://www.taylorwessing.com/en/interface/2025/accessibility/the-european-accessibility-act-and-its-implementation)). A solo developer selling a licence may qualify as a service-provider microenterprise, but classification as product vs service and crossing the threshold both matter. **Do not rely on it; build to the standard anyway** (also store policies and enterprise buyers ask).
- **Enforcement:** national (Art. 30); e.g. German fines up to EUR 100,000. Swedish transposition not checked **[verify]**.
- **Standards:** EN 301 549 V3.2.1 (maps to WCAG 2.1 AA) is the cited harmonised standard giving presumption of conformity. V4.1.1 (WCAG 2.2 AA, new EAA mapping) was reported adopted Aug-Sep 2026 but not yet confirmed as cited in the OJ ([Deque](https://www.deque.com/blog/en-301-549-v4-1-1-is-final-what-changed-what-it-means-and-what-you-should-do/), [Dentons](https://www.dwt.com/insights/2026/09/european-accessibility-act-ict-standards-update)). Target **WCAG 2.2 AA** now. Native TV apps are "non-web software" in EN 301 549 (clause 11), so the WCAG criteria apply by analogy, plus clauses on closed functionality, assistive-tech compatibility, user preferences and captioning/AD controls.
- **Practical obligations to implement:** screen-reader operability of all functions; text alternatives; contrast; no colour-only; keyboard/D-pad operability with no traps; focus visibility; timing control; consistent navigation; accessible authentication (WCAG 2.2 3.3.8: no cognitive-test-only login, so pairing codes need copy/QR alternative); an **accessibility statement** and feedback contact; caption/AD controls; documented known limitations.

## 3. Onboarding for non-technical users

Pain: typing long URLs/credentials with a D-pad is the stated #10 pain in user-needs-2026-10. Patterns, none of which need our servers to see credentials (rule 7):

1. **Phone-to-TV via local network (preferred, zero server):** TV starts a tiny LAN HTTP(S) listener or uses WebRTC data channel; shows a QR with `http://192.168.x.x:port/` plus a short code. Phone opens a form (paste URL, or Xtream host/user/pass), submits straight to the TV. Tizen/webOS web apps cannot open server sockets **[unverified]**, so this works for Android TV/desktop/Apple but needs a fallback on Tizen/webOS.
2. **Relay with end-to-end encryption (fits rule 7):** device-flow style, like RFC 8628: TV shows a short code + QR (`verification_uri_complete`), phone opens a static page, encrypts the playlist URL client-side with a key carried only in the QR/URL fragment (never sent to the server), posts ciphertext to a dumb mailbox keyed by the code, TV polls and decrypts. Server sees ciphertext only; it is not "proxying" content. Best practice from [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628) and [Descope](https://www.descope.com/learn/post/device-authorization-flow): show code and QR both, confirm code match on the phone to avoid phishing, honour `interval`/`expires_in`, regenerate on expiry, rate-limit. Short code alphabet without 0/O/1/I, case-insensitive. Needs lawyer sign-off since it is a mailbox service, though it holds no content.
3. **Paste / import fallbacks:** USB/file picker, clipboard (desktop), "type on TV" with a good OSK (history of recent hosts, `http://`/`https://`/`.m3u` quick-keys, show-password toggle, voice dictation where the OS offers it).
4. **Magic links** only if we introduce accounts; with one licence per account, send the phone a link that opens the pairing page already filled with the TV's code. Avoid password entry on the TV.
5. **Guided first run:** 3 steps max: language, "add your source" (the three lawful use cases: own media server, free-to-air, operator-provided M3U, HDHomeRun, per rule 10), done. No bundled lists (rule 1). Show progress and let the user go to the player the moment the first 50 channels parse (stale-while-revalidate).
6. **Empty states** that teach: a single large primary action, one sentence of plain language ("Add a playlist from your own source"), a "Show me how" with the QR, and no provider links (rule 2).
7. **Error recovery in plain words**, with one next action each: "Can't reach the address" / "The server said no (403)" / "Wrong username or password" / "This list is empty" / "No picture on this channel" (retry, try the other format automatically). Offer "Copy details for support" (diagnostics screen from user-needs). Keep the old good list if a refresh fails.

## 4. Families and kids

- **Profiles:** per-profile favourites, hidden groups, language, subtitle style, parental level; profile switch needs PIN only to leave a kids profile (HBO Max, Netflix patterns; [HBO Max](https://help.hbomax.com/dk-en/Answer/Detail/000001246)).
- **PIN:** 4 digits, no default (Samsung's "0000" default is a known weakness), set at first use; recovery without reinstall (a local recovery question or device-owner confirmation; JellyWatch's "reinstall" is a poor example: [JellyWatch](https://jellywatch.app/doc/android-tv/tv-kids-profile)). PIN guards: leaving kids mode, unlocking locked groups, editing sources, adding profiles. Lock-out after 5 failures. PIN must work by number keys and D-pad (accessible auth).
- **Netflix split:** account-level hard PIN vs profile-level soft limits ([summary](https://lowyat.net/2019/199516/how-to-set-up-parental-controls-on-netflix)); we have no ratings, so use **allow-lists**: kids profile shows only groups/channels a parent explicitly enabled.
- **Kids UI:** big tiles, 2-row home, no search keyboard, no settings, no source management; exit = hold BACK + PIN. Fewer, larger choices (matches Samsung Kids Mode large-button approach: [Samsung](https://technewstt.com/pr-samsung-kidsmode/)).
- **Hiding adult groups automatically:** playlists carry only free-text `group-title` and tags; there is no reliable rating. My recommended approach **[own design, not sourced]**: (a) heuristics only *suggest* groups to lock at first run, in many languages (xxx, adult, 18+, erotic, porn, +18, mature, plus Arabic/Turkish/Persian/Polish/German/etc. terms), using whole-token matching with Unicode normalisation; (b) never silently delete: show "Locked N groups, review"; (c) known false positives (Essex, Sussex, Scunthorpe, "Xxxx", "adult swim"-style or "adult education", "18+" age labels in documentaries, Turkish "yetişkin" vs "yetişkin eğitimi", Polish place names): allow-list overrides plus a one-tap "unlock" with PIN; (d) in kids profiles use allow-list, not heuristics. Treat heuristics as a convenience, not a safety guarantee, and say so in copy (also avoids a "safe for kids" liability claim).
- **Time limits:** daily limit per profile, sleep timer (already a v1.1 item), warning at 5 min, hard stop to a "time's up" screen needing PIN to extend. Local only.
- **Copy:** neutral, no content or broadcaster names (rules 3-4).

## 5. Elderly / simple mode

Evidence: Ofcom found channel selection by number buttons is easy for over-65s and that EPG/on-demand menus are where they fail ([Ofcom](https://www.ofcom.org.uk/internet-based-services/technology/identifying-challenges-and-solutions-for-improving-inclusivity-and-usability-in-the-consumption-of-internet-delivered-television)); older users in a 2011 study watched only 4-7 channels and wanted simpler devices ([Abertay](https://rke.abertay.ac.uk/en/publications/using-motion-sensing-remote-controls-with-older-adults/)); Chinese seniors found remote text search hard, voice best ([Dou et al. 2019](https://ideas.repec.org/a/taf/tbitxx/v38y2019i7p664-677.html)). Samples are small; no IPTV-specific demand data found.

Spec **Simple Mode** (a profile type, enabled at first run or in settings):
- Opens directly on the last channel; **OK** shows a big banner; **Up/Down and CH+/-** change channel; **number keys** zap with a 2-second digit buffer and a large on-screen number; **0/Last** toggles previous channel.
- One list: "My channels" (favourites only, numbered 1..N, user-orderable by a helper), 6 rows visible, 40 px+ text, no groups, no EPG grid, no search, no settings; "Now and Next" in the banner.
- Visible hints in plain words ("Press OK for the menu"), no jargon (avoid "playlist", "EPG", "stream" in this mode: "channels", "programme guide").
- Settings lock behind PIN so a helper sets it up once, the user can't break it. Large Help screen with the remote diagram.
- Same player controls but fewer: volume (system), subtitles, audio, nothing else.

## 6. Localisation

- **Evidence of multilingual use:** store listings of generic player apps advertise 24+ UI languages including Arabic, Persian, Polish, Turkish ([Apple TV listing example](https://apps.apple.com/mk/app/all-iptv-player-pro/id6474459473)); one open-source tool localises into 14 languages with RTL Arabic/Persian ([IPTVChecker release](https://newreleases.io/project/github/kristofferR/IPTVChecker/release/v2.2.0)); a middleware vendor argues provider audiences are rarely single-language ([Infomir]([link removed])). **No audience-size or survey data found.** Treat "heavily multilingual" as plausible, validate with first-run language-choice analytics (privacy-preserving, opt-in) later.
- **RTL:** mirror layout (rows, EPG timeline direction, back/forward icons, progress bars), but D-pad semantics: left/right physically still move spatially, so reverse list order, not key meaning; keep Latin channel numbers/times LTR using bidi isolation. Provide a layout-direction pseudo-locale in tests.
- **Canvas text:** Lightning 3 has Canvas2D "web" fonts and SDF fonts (WebGL only). Web fonts use the browser's text shaping (Arabic joining, bidi) when the font supports it; SDF atlases are per-glyph and **cannot** do Arabic contextual shaping or CJK without pre-shaped atlases [Renderer README](https://cdn.jsdelivr.net/npm/@lightningjs/renderer@3.0.2/README.md); I found no Lightning RTL/Arabic documentation **[unverified, must prototype]**. Plan: SDF for Latin/Cyrillic/Greek UI chrome; Canvas2D web-text for Arabic/Hebrew/Persian/CJK/Thai/Devanagari and for any channel/EPG string (user data is unbounded), with a font-fallback chain (Noto Sans Arabic/CJK). Tizen/webOS system fonts differ; bundle subsetted Noto fonts and measure memory on 1 GB TVs. Channel names with mixed scripts need `dir="auto"`-style handling.
- **Time/date:** use `Intl.DateTimeFormat` with the device locale, 12/24 h override, first day of week from `Intl.Locale.weekInfo` (check availability on old Chromium; ship fallback table), and the user's EPG offset from the user-needs doc. Never format by hand-rolled strings.
- **EPG language:** XMLTV `<title lang>` and `<desc lang>` can repeat; pick by preference list (UI language, then user-ordered list, then first). Keep it a setting under "Language".
- **Audio/subtitle defaults:** ordered preference list (e.g. Polish, then original), matched on ISO 639-1/2 and 639-2/B vs /T variants and names found in streams; remember per channel; default subtitles off unless the accessibility setting says on. Reuse OS preferences where available.
- **Strings:** ICU MessageFormat for plurals (Arabic has six plural forms, Polish three), no concatenation, 30-40% expansion budget, no text in images.

## 7. Prioritised requirements

Legend: Effort S (<0.5 d), M (~1 d to a few days), L (multi-week). Legal: **EAA** = reasonably expected under EAA/EN 301 549 for AV-media apps (confirm scope); **BP** = best practice.

| # | Requirement | Effort | Impact | Legal |
|---|---|---|---|---|
| 1 | Always-visible two-tone focus ring, one focus at a time, no traps; BACK steps one level | S | High | EAA (WCAG 2.4.7, 2.4.11) |
| 2 | Text >= 28 px at 1080p; text-scale 100-150% (200% in HC); 5% safe margin, adjustable | M | High | EAA (1.4.4, 1.4.12) / BP |
| 3 | Contrast >= 4.5:1 text, 3:1 icons; no colour-only meaning; in-app High Contrast theme | M | High | EAA (1.4.3, 1.4.11, 1.4.1) |
| 4 | Screen-reader support via hidden DOM mirror + ARIA on Tizen/webOS/desktop; live region; manifest flag on webOS; autofocus on Tizen | L | High (blind users) | EAA (4.1.2, 1.1.1) |
| 5 | Fallback built-in speech layer (Announcer-style) with no double-speak | M | Med | EAA (as fallback) / BP |
| 6 | Native a11y on Android TV (TalkBack) and Apple (VoiceOver) apps | M | High | EAA |
| 7 | Captions: render CEA-608/708/WebVTT/DVB text ourselves with size/colour/background/position settings | L | High | EAA (Annex I IV(b)(ii)) |
| 8 | Subtitle and audio track picker including Audio Description labelling, reachable by D-pad, remembered per channel | M | High | EAA |
| 9 | EPG shows icons/text for CC/AD availability when stream/EPG data flags them | S | Med | EAA (IV(b)(i)) |
| 10 | Reduce-motion setting (also honour `prefers-reduced-motion`), no flashing | S | Med | EAA (2.3.1, 2.3.3) / BP |
| 11 | Info banner timeout configurable; no auto-dismissed critical text | S | Med | EAA (2.2.1) |
| 12 | Accessible authentication: pairing code + QR + manual entry; PIN not memory/cognitive-only trap | S | Med | EAA (3.3.8) |
| 13 | Accessibility statement + feedback contact in-app and on site | S | Med | EAA (obligation) |
| 14 | Phone pairing for playlist entry (E2E-encrypted relay or LAN) with plain-language errors | L | Very high | BP |
| 15 | Guided 3-step first run + empty states + diagnostics copy screen | M | Very high | BP |
| 16 | Profiles + parental PIN (no default) + locked groups + kids allow-list profile | L | High | BP |
| 17 | Adult-group heuristic suggestions (multilingual, whole-token, reviewable) | M | Med | BP |
| 18 | Sleep timer and daily time limit | S | Med | BP |
| 19 | Simple Mode (number zapping, favourites-only, big banner, PIN-locked settings) | M | High (older users) | BP |
| 20 | Number-key zapping with digit buffer, previous-channel key, CH+/- (all modes) | S | High | BP |
| 21 | i18n with ICU plurals; Intl date/time; week start; locale-aware sorting | M | High | BP |
| 22 | RTL layout mirroring (Arabic, Hebrew, Persian) | L | High for those users | BP |
| 23 | Canvas text path for complex scripts and CJK (web-font text, bundled Noto subsets, memory-tested) | L | High | BP / EAA-adjacent (text must be readable) |
| 24 | Language preference lists for audio, subtitles, EPG text | M | Med-high | BP |
| 25 | Voice search/dictation where the OS offers it, never required | M | Med | BP |

Suggested order: 1, 2, 3, 10, 11, 20, 15 first (cheap, universal); then 4/5/6 spike and 7/8 (largest compliance and user value); then 14, 16, 19; then localisation 21-24.

## 8. What this means for our Lightning/SolidJS TV app

1. **Canvas = no accessibility tree.** On Tizen and webOS the TV's screen reader reads DOM only, so a pure Lightning canvas is silent to Voice Guide/Audio Guidance. That is the largest EAA exposure and a blocker for blind users. Decision needed early: build the **DOM mirror** (item 4), prototype on a real Samsung and LG TV before committing to the architecture.
2. **Single focus store.** SolidJS fine-grained signals suit this: one `focusedNode` signal drives both the Lightning focus visual and the hidden DOM `.focus()` plus label. Components declare `a11y: {role, name, description, state}` next to their render props; lint that every focusable has a name.
3. **Virtualised lists** (50k channels) must expose only a window to the DOM mirror and announce position ("12 of 5,000"). Never mirror all rows (memory on 1 GB TVs).
4. **Announcer behaviour:** Lightning 2's Announcer pattern (collect strings along the focus path, queue, cancel on new focus, optional pre-roll) is worth copying for the fallback layer; confirm Lightning 3 has none and write ours. Cancel speech on channel zap and on app background (Netflix lesson).
5. **Text and fonts:** decide per script between SDF and Canvas2D; verify Arabic shaping and bidi on-device before promising RTL; budget font memory; pick a layout system that can flip direction (logical start/end instead of left/right in layout code, while key handling stays physical).
6. **Theming tokens:** colours, sizes, motion durations, focus style come from tokens so High Contrast, large text, reduced motion, and profile modes are theme switches, not forks.
7. **Captions are ours:** render subtitle cues as a Lightning layer (for AVPlay `onsubtitlechange`, hls.js cues, extracted 608/708) with user styling; decide whether bitmap DVB subtitles are supported (scale/position only).
8. **Pairing:** webOS/Tizen apps likely cannot host a LAN server, so the E2E relay or a QR-to-static-page flow is the only cross-platform path; keep credentials client-encrypted (rule 7) and confirm legal acceptability.
9. **Testing:** add automated checks (contrast of tokens, every focusable has a label, no focus traps via traversal test) plus a manual matrix: Samsung Voice Guide, LG Audio Guidance, TalkBack, VoiceOver, 200% text, HC, reduced motion, Arabic pseudo-locale, D-pad-only.
10. **Legal posture:** build to WCAG 2.2 AA / EN 301 549; keep the accessibility statement; get a lawyer to confirm whether the app is an EAA service and whether the microenterprise exemption applies, but do not make shipping decisions depend on the exemption.

## 9. Open questions
- Does `speechSynthesis` exist and work on current Tizen and webOS TV browsers? Does the DOM mirror actually get read when the Lightning canvas holds the visible UI?
- Do Tizen/webOS expose high-contrast/reduced-motion/font-scale to web apps? None documented in what I found.
- Does Lightning 3 shape Arabic correctly in Canvas2D mode; what is its font memory cost?
- Final text of EAA Art. 2/4 and Swedish transposition; EN 301 549 V4.1.1 OJ citation status.
- Real demand data for simple mode and multilingual use: validate in beta.
