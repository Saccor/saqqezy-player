# Try v1 on your computer

This guide runs the TV app in a desktop browser. You need about 10 minutes. You do not need to know how to
program; you only type a few commands.

The app ships with **no channels**. To try it you can use the built-in **fake provider** (made-up test
channels that play a public test video) or a source you already have the right to use.

## 1. What you need

- **Node.js 22 or newer.** Download the "LTS" installer from nodejs.org and run it. Check it in a terminal:

  ```
  node -v
  ```

  It should print `v22.something` or higher.

- **pnpm 10.** Node comes with a helper called Corepack that installs it for you. Run once:

  ```
  corepack enable
  ```

  Then check it with `pnpm -v` (it should print `10.something`). If Windows says "access denied", open the
  terminal with **Run as administrator** and run `corepack enable` again.

- **Google Chrome or Microsoft Edge** (recent version).

On Windows, "terminal" means **PowerShell** or **Windows Terminal** (search for it in the Start menu).

## 2. Start the app

In the terminal, go to the project folder (the folder that contains `package.json`), then run:

```
pnpm install
pnpm dev
```

- `pnpm install` downloads what the app needs. It is only needed the first time, and again after an update.
- `pnpm dev` starts two things: the fake provider at `http://127.0.0.1:8899` and the app at
  `http://localhost:5173`. Leave this terminal open while you use the app.

Open **http://localhost:5173** in Chrome or Edge.

- **Use one browser tab.** The app keeps its saved data in the browser, and two tabs of it at the same time can
  get in each other's way. Close any other tab with the app before you open a new one.
- **Use a widescreen (16:9) browser window,** e.g. full screen with **F11**. The app is laid out for a TV screen;
  in a narrow or tall window it is drawn smaller, with empty bars around it.

To stop the app, click in the terminal and press **Ctrl+C**.

## 3. Keys: your keyboard is the remote

The app is made for a TV remote. On a computer these keys stand in for the remote buttons:

| PC key | Remote key | What it does |
|---|---|---|
| Arrow keys | Up / Down / Left / Right | Move around |
| Enter | OK | Choose, watch. Hold for about 0.6 s for the options menu |
| Backspace or Esc | Back | Close the top layer, go back. On the Channels screen it asks to exit |
| M | Menu | Options for the focused channel or the player |
| I | Info | Show or hide the channel banner while watching |
| Page Up / Page Down | Channel + / Channel − | Next / previous channel, or a page up/down in lists |
| 0 to 9 | Number keys | Type a channel number while watching |
| Space | Play/Pause | Not used yet |
| F1 | Red | Previous channel (while watching) |
| F2 | Green | TV guide (from the Channels screen) |
| F3 | Yellow | Search (from the Channels screen). In a password field: show or hide the password |
| F4 | Blue | Settings (from the Channels screen) |

While the on-screen keyboard is open you can also type on your real keyboard. Letters, digits and
Backspace go into the field; Esc closes the keyboard and keeps the text.

Debug overlay (start-up time, frame rate, player state): press **I three times** within 2 seconds, press **F12**
(in a desktop browser), or turn it on in Settings → Diagnostics.

## 4. Log in with the fake provider

1. The first screen is **Add your TV source**. Choose **Xtream login** (press Enter).
2. Fill in the fields. Press Enter on a field to open the keyboard, type, then press Esc to close it:
   - **Server:** `http://127.0.0.1:8899`
   - **Username:** `test`
   - **Password:** `test`
3. Go down to **Log in** and press Enter.

After a moment you see **Channels** with 200 test channels in four groups. Moving through the list never
changes what plays. Things to try:

- **Enter** on a channel: it plays in the small video. **Enter** again: watch it full screen. There **Up/Down** or
  **Page Up/Down** zaps, digits jump to a number, **F1** goes back to the previous channel, **M** opens options
  (audio, aspect ratio, sleep timer, stream info, favourite).
- **M** on a channel in the list: add it to favourites, or hide it. Hidden channels come back in
  Settings → Channels.
- **F2**: the TV guide. **F3**: search by name or number. **F4**: Settings.
- Close the browser tab and open it again: the app opens on the last channel within a second.

You can also add the fake provider as an **M3U link** (Settings → Sources → Add source → M3U link):

- Playlist URL: `http://127.0.0.1:8899/get.php?username=test&password=test&type=m3u_plus`
- TV guide URL: `http://127.0.0.1:8899/xmltv.php?username=test&password=test`

A new source is not used until you pick it: in Settings → Sources, press Enter on it and choose
**Set as active**.

## 5. Use your own source

Add it the same way (Xtream login or M3U link) with the details you got from your own service. Only add
sources you have the right to use.

Good to know when you try your own source **in a browser**:

- **It goes through a local helper.** Many services do not allow web pages to read their lists directly. While
  `pnpm dev` runs, the app's requests go through a small helper on your own computer (the "dev proxy"). Nothing
  is sent anywhere else. On a TV the app connects directly and this helper is not used.
- **Start the app with `pnpm dev:stable` instead of `pnpm dev`.** It never reloads the page by itself when code
  changes (press F5 to load changes). Every reload opens new connections to your service, and some services block
  devices that connect too often.
- **In the browser (`pnpm dev` or `pnpm dev:stable`), the app does not resume a channel from your own source after a
  page reload:** the preview says "Paused after reload: press OK to play". The local fake source still resumes.
- **If your service offers an Xtream login, prefer it in the browser.** It loads faster than a big playlist
  link, finds the TV guide by itself, and lets the app try each channel in its other stream format.
- **Most desktop Chrome/Edge setups can't decode AC3/E-AC3 (Dolby) audio.** Those channels may fail to start or
  have no sound on a PC but should work on the TV.
- **If a channel will not start,** change the stream format: Settings → Playback → **Preferred stream format**
  (TS or HLS), then try the channel again. The app already tries the other format once by itself.
- **Big lists take a while the first time.** Later starts use the saved copy and are fast.

## 6. Manage from your phone (local test)

v1.1 adds **Settings → Manage on phone or computer** on the TV: you organise sources, lists, groups and channels
from a web page instead of with the remote. The TV and the page talk through a small **relay** that only passes
encrypted messages along. For this test all three parts run on your computer.

**Start three things,** each in its own terminal, all in the project folder:

| Terminal | Command | What it starts |
|---|---|---|
| 1 | `pnpm dev` | The TV app (http://localhost:5173) and the fake provider |
| 2 | `pnpm relay:dev` | The relay on `127.0.0.1:8787` (local only, no Cloudflare account needed) |
| 3 | `pnpm companion:dev` | The companion web page (http://localhost:5174) |

Then:

1. Open **http://localhost:5173** (the TV) in one browser tab. Log in to a source first (section 4).
2. On the TV press **F4** (Settings) and choose **Manage on phone or computer**. It shows a QR code.
3. Open **http://localhost:5174** (the companion) in a second tab, next to the TV tab if you can.
4. Connect, in one of two ways:
   - **By QR link.** You cannot scan the screen with the same computer, so copy the link instead: in the TV tab press
     F12, open **Console** and type `(await __iptv.pairing()).qrUrl`, then press Enter. Copy the link it prints (without the
     quotes) into the companion tab's address bar and press Enter. (This console helper exists only in this local
     test version.)
   - **By code.** On the TV, go right into the page, then press **F3** (Yellow) or choose **Use a code instead**. Type
     the 12-character code into the companion page and click **Connect**. Small letters and missing dashes are fine.
5. After a few seconds the companion shows your sources, and the TV says **Connected**.

Things to try on the companion page: **Add source** (for example the fake provider: server
`http://127.0.0.1:8899`, username `test`, password `test`), **My lists** (create a list, add channels, drag them
into order), **Groups** (hide a group, drag groups, open one to rename channels or sort A–Z) and **Display**
(hide channels without TV guide). Each change shows on the TV within about a second. Changes you make on the TV
(for example **M** → Add to list) show on the companion too.

Good to know:

- **Codes expire.** A code that nobody uses expires; in this local test that takes only about a minute (on the real
  service, 15 minutes). The TV then says **This code has expired**: choose **Show a new code**.
- **Reloading the companion page disconnects it.** It keeps nothing, on purpose. Connect again with a new code.
- **Disconnect** on the TV ends the session at once; the companion page then says the TV closed the session.
- **A real phone cannot use this local test.** The page needs a secure (`https`) connection for its encryption,
  and `localhost` only counts as secure on the computer itself. To use your phone, deploy the companion (see
  [Deploying the companion](deploy-companion.md)), or serve the local version over HTTPS with your own certificate.

## 7. Put it on a Samsung TV

See [Installing the app on a Samsung TV](install-on-samsung.md). It needs a 2021 or newer Samsung TV and takes
about an hour the first time.

## 8. What is not in v1

Catch-up, timeshift, recording, parental PIN, profiles, LG TVs and more are planned for later. See the
[backlog](backlog.md).

## 9. Troubleshooting

**"Port 5173 is already in use" or "port 8899" errors when you run `pnpm dev`.**
Another copy of the app is probably still running. Close other terminals that run `pnpm dev`, or find and stop
the program that holds the port. On Windows (PowerShell):

```
netstat -ano | findstr :5173
taskkill /PID <the number at the end of the line> /F
```

Use `:8899` instead of `:5173` for the fake provider. Then run `pnpm dev` again.

**The page is blank or black.**
- Wait a few seconds and reload (F5). The first start after `pnpm install` takes longer.
- Check that the terminal running `pnpm dev` shows no errors and is still running.
- Use a recent Chrome or Edge. The app needs WebGL; if it is turned off in the browser, nothing is drawn.
- If you see **"Couldn't load your saved data"**, press **Retry**. If it keeps coming back, reset the data (below).

**A channel stays black or says it isn't available.**
The fake provider's test video comes from the internet, so you need a connection. For your own source, see
"If a channel will not start" above.

**Reset everything (start over).**
- To keep your sources but download the channels and guide again: Settings → Storage →
  **Clear cached channels and guide**.
- To remove a source: Settings → Sources → the source → **Delete**.
- To wipe all app data in the browser: press F12 to open the browser's developer tools, go to
  **Application** → **Storage** → **Clear site data**, then reload the page. (F12 also toggles the app's debug
  overlay; that is harmless.)

**`pnpm` is not found.**
Run `corepack enable` again (as administrator on Windows), close the terminal, open a new one and retry.
