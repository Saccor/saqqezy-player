# Installing the app on a Samsung Odyssey OLED G9

> **First attempt, not yet verified on this model.** Nobody has installed this app on the Odyssey OLED G9 yet.
> The steps follow Samsung's documentation and community guides for sibling devices. Stop at the first step that
> does not match what you see, and write down what happened.

This guide is for a Windows PC and no programming knowledge. The app plays **your own** sources only; it comes
with no channels. It takes about 30 minutes.

## What you need

- The Odyssey OLED G9 and its remote.
- A Windows PC on the **same home network** as the monitor (same Wi-Fi or router, not a guest network).
- A free **Samsung account**.
- The file `dist-tizen/Saqqezy-Player-unsigned.wgt` (see Step 1).

## Step 1: Build the file

In a terminal in the app's folder, run exactly this command:

```
pnpm build:tizen
```

It prints `Unsigned package: dist-tizen/Saqqezy-Player-unsigned.wgt`. That file is the app. You do not need Tizen
Studio for this step. (If you only received the `.wgt` file from someone, skip this step.)

## Step 2: Find your PC's IP address

1. Open a terminal and type `ipconfig`.
2. Find **IPv4 Address**, for example `192.168.1.20`. Write it down.

## Step 3: Turn on Developer Mode on the monitor

1. On the monitor, press Home and open **Settings > Support > About** and note the software version.
2. Open **Apps**.
3. Press the **123** key on the remote to show the on-screen number pad. If there is no such key, use the
   **SmartThings** phone app (pair the monitor, open its remote and its number pad).
4. Enter **1 2 3 4 5**.
5. Switch **Developer mode** to **On**.
6. Type your **PC's IP address** from Step 2 (not the monitor's) and select **OK**.

## Step 4: Restart the monitor

1. Hold the **power button** for 5 seconds or more until the monitor restarts. A normal stand-by is not enough.
2. Open **Apps** again. You should see a "DEVELOP MODE" label.
3. Find the **monitor's IP address**: Settings > General > Network. Write it down.

## Step 5: Install Apps2Samsung and the app

1. Download the **latest release** of **Apps2Samsung** from its GitHub Releases page (search for
   "Apps2Samsung github") and start it.
2. Sign in with your **Samsung account** when it asks. Apps2Samsung makes the certificate for your monitor by itself.
3. Select the monitor in the list. If it is not found, type the monitor's IP address from Step 4.
4. Choose **custom .wgt** as the source, then pick `dist-tizen\Saqqezy-Player-unsigned.wgt` in the app's folder.
5. Start the install. When it finishes, open **Apps** on the monitor and start **Saqqezy Player**.

If Apps2Samsung says the package is rejected (a signature or author certificate error), uninstall any older
copy from the monitor first, then try again. If it still fails, use the fallback below.

## Fallback: Tizen Studio

Follow [install-on-samsung.md](install-on-samsung.md). Choose a Samsung certificate profile for **TV**; the
monitor's DUID is filled in from Device Manager after `sdb connect <monitor-ip>`. Then run
`$env:TIZEN_PROFILE="MyTV"; pnpm build:tizen` in PowerShell and install the signed package it prints.

## If something fails

- Developer Mode only accepts the **PC's** IP. If the PC's IP changed, enter the new one and restart the monitor.
- If the IP looks reversed after entry, enter the four numbers in reverse order (Apps2Samsung FAQ).
- If the PC cannot reach the monitor, unplug the monitor for 10 to 15 seconds and try again.
- No 123 key and SmartThings does not help: there is no other documented route. Ask in the Apps2Samsung issues
  and include the software version from Step 3.

## Step 6: Write down what the Diagnostics page says

The big unknown is how the app looks on a 32:9 panel. Open **Settings > Diagnostics** in the app and write down:

- **Player**: "AVPlay" or "HTML5".
- **Viewport**, **Screen**, **pixel ratio** and **design scale** (the picture size numbers).
- **Device** (Tizen version and model) and **Engine**.
- Whether the picture fills the whole screen or has black bars at the sides, and whether video plays in the
  Home preview and in full screen.

These numbers decide the next step (wider layout for 32:9). If the page is cut off, take a photo of the screen.
