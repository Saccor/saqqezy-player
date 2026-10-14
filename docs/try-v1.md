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

To stop the app, click in the terminal and press **Ctrl+C**.

## 3. Keys: your keyboard is the remote

The app is made for a TV remote. On a computer these keys stand in for the remote buttons:

| PC key | Remote key | What it does |
|---|---|---|
| Arrow keys | Up / Down / Left / Right | Move around |
| Enter | OK | Choose, watch. Hold for about half a second for the options menu |
| Backspace or Esc | Back | Close the top layer, go back. On the Channels screen it asks to exit |
| M | Menu | Options for the focused channel or the player |
| I | Info | Show or hide the channel banner while watching |
| Page Up / Page Down | Channel + / Channel − | Next / previous channel, or a page up/down in lists |
| 0 to 9 | Number keys | Type a channel number while watching |
| F1 | Red | Previous channel (while watching) |
| F2 | Green | TV guide (from the Channels screen) |
| F3 | Yellow | Search (from the Channels screen). In a password field: show or hide the password |
| F4 | Blue | Settings (from the Channels screen) |

While the on-screen keyboard is open you can also type on your real keyboard. Letters, digits and
Backspace go into the field; Esc closes the keyboard and keeps the text.

Debug overlay (start-up time, frame rate, player state): press **I three times** within 2 seconds, or turn it on
in Settings → Diagnostics.

## 4. Log in with the fake provider

1. The first screen is **Add your TV source**. Choose **Xtream login** (press Enter).
2. Fill in the fields. Press Enter on a field to open the keyboard, type, then press Esc to close it:
   - **Server:** `http://127.0.0.1:8899`
   - **Username:** `test`
   - **Password:** `test`
3. Go down to **Log in** and press Enter.

After a moment you see **Channels** with 200 test channels in four groups, and the first one plays in the
preview. Things to try:

- **Enter** on a channel: watch it full screen. **Up/Down** or **Page Up/Down** zaps, digits jump to a number,
  **F1** goes back to the previous channel, **M** opens options (audio, aspect ratio, sleep timer, stream info,
  favourite).
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
- **Some channels may have no sound on a PC.** Browsers cannot play AC3 / E-AC3 (Dolby) audio. Those channels
  show a picture but stay silent on a computer; the same channels should have sound on a TV.
- **If a channel will not start,** change the stream format: Settings → Playback → **Preferred stream format**
  (TS or HLS), then try the channel again. The app already tries the other format once by itself.
- **Big lists take a while the first time.** Later starts use the saved copy and are fast.

## 6. Put it on a Samsung TV

See [Installing the app on a Samsung TV](install-on-samsung.md). It needs a 2021 or newer Samsung TV and takes
about an hour the first time.

## 7. What is not in v1

Catch-up, timeshift, recording, VOD, parental PIN, profiles, LG TVs and more are planned for later. See the
[backlog](backlog.md).

## 8. Troubleshooting

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
