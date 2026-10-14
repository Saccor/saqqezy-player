# Installing the app on a Samsung TV

> **Not yet verified on a real TV.** These steps follow Samsung's developer documentation, but nobody has
> installed this build on an actual TV yet. If a step does not match what you see, please note what happened.

This guide puts the app on your own Samsung TV in **developer mode**. You need a Windows, Mac or Linux
computer on the **same home network** as the TV. It takes about an hour the first time.

## Which TVs work

- Samsung Smart TVs from **2021 or later** (Tizen 6.0 or newer).
- Older models (2020 and earlier) are **not supported**: their built-in browser engine is too old for this app.
  The app may install there but will most likely show a black screen.
- To find your TV's model year, see [Troubleshooting](#how-do-i-find-my-tvs-model-year).

The app plays your own sources only. It does not come with any channels.

---

## Step 1: Install the tools on your computer

1. Download and install **Tizen Studio** from Samsung's developer site (search for "Tizen Studio download").
   The smaller "CLI" (command-line) version is enough if you prefer.
2. Open the **Package Manager** that comes with Tizen Studio.
   - On the **Main SDK** tab, install the **Tizen SDK tools**.
   - On the **Extension SDK** tab, install **Samsung Certificate Extension** and **TV Extensions** (the newest
     version listed).
3. Add Tizen's command-line tools to your PATH so the `tizen` and `sdb` commands work in a terminal. They are
   in the Tizen Studio folder under `tools/ide/bin` (for `tizen`) and `tools` (for `sdb`).
   - Check it worked: open a new terminal and type `tizen version`. You should see a version number.
4. You also need **Node.js** and **pnpm** to build the app (the same tools used to develop it).

## Step 2: Turn on developer mode on the TV

1. Find your computer's IP address (for example `192.168.1.20`).
   - Windows: open a terminal and type `ipconfig`, look for "IPv4 Address".
   - Mac: System Settings > Network > your connection.
2. On the TV, open the **Apps** screen.
3. With the Apps screen open, press **1 2 3 4 5** on the remote.
   - If your remote has no number buttons, press the **123** (or colour) button to show an on-screen number pad.
4. A "Developer mode" window opens. Switch **Developer mode** to **On**.
5. Enter your **computer's** IP address from point 1 (not the TV's). Select **OK**.
6. **Restart the TV**: hold the power button on the remote until the TV turns off and on again (a normal
   power-off is not enough). Back on the Apps screen you should see "Developer mode" at the top.
7. Find the **TV's** IP address: Settings > General > Network > Network Status > IP Settings.

## Step 3: Connect to the TV and create a certificate

Samsung only installs apps that are signed with a certificate made for **your** TV.

1. Connect your computer to the TV. In a terminal type (use the TV's IP address):

   ```
   sdb connect 192.168.1.50
   sdb devices
   ```

   `sdb devices` lists the TV with a name such as `UE55XXXXX`. Write this **device name** down.
2. Open Tizen Studio's **Device Manager**. The TV appears in the list. Right-click it and choose
   **Permit to install applications**. (This tells the TV to trust your computer.)
3. Open Tizen Studio's **Certificate Manager** and click **+** to create a new certificate profile:
   - Choose **Samsung** (not Tizen), then **TV**.
   - Give the profile a simple name, for example `MyTV`. Write it down: this is your **profile name**.
   - Create a new **author certificate** (any name and password; keep the password safe). You will be asked
     to sign in with a Samsung account.
   - Create the **distributor certificate**. On the device (DUID) step, your connected TV's **DUID** is filled
     in automatically from Device Manager. If it is not, make sure step 1 and 2 above worked, then try again.
   - Finish. The new profile should be marked as active.

## Step 4: Build and install the app

1. Once only: open `apps/tv/tizen/config.xml` in a text editor and replace both `XXXXXXXXXX` with your own
   10-character package ID (letters and digits). The easiest way to get one: in Tizen Studio create a new
   "TV > Web Application > Basic Project", and copy the package ID from that project's `config.xml`.
2. In a terminal, in the app's folder, build the signed package with your **profile name**:

   - Mac / Linux:

     ```
     TIZEN_PROFILE=MyTV pnpm build:tizen
     ```

   - Windows (PowerShell):

     ```
     $env:TIZEN_PROFILE="MyTV"; pnpm build:tizen
     ```

   At the end it prints the name of the package it made (a file ending in `.wgt` inside `dist-tizen`) and the
   exact install command.
3. Install it on the TV, using the `.wgt` name it printed and your TV's **device name** from step 3:

   ```
   tizen install -n "IPTV Player.wgt" -t UE55XXXXX -- dist-tizen
   ```

4. The app appears on the TV's Apps screen as **IPTV Player**. Open it and add your source in Settings.

To update the app later, repeat step 4 (points 2 and 3). The TV must still be in developer mode with your
computer's IP address.

---

## Troubleshooting

### "Certificate" or "signature" errors when installing

- The package must be signed with the **Samsung** certificate profile that contains **this TV's DUID**. A Tizen
  (non-Samsung) profile, or a profile made for another TV, is refused.
- Make sure the right profile is **active** in Certificate Manager and that `TIZEN_PROFILE` has exactly its name.
- If an older copy of the app was installed with a different certificate, uninstall it from the TV first
  (Apps > the app > Delete), then install again.
- After re-creating a certificate, build again: the old `.wgt` is still signed with the old one.

### The TV is not found, or "Permit to install" is missing

- Developer mode must contain your **computer's** IP address, not the TV's. If your computer's IP changed (for
  example after a router restart), enter the new one in developer mode and **restart the TV** again.
- Computer and TV must be on the same network. Some routers block devices from seeing each other ("guest
  network" or "AP isolation"): use the main network.
- Try `sdb disconnect` and then `sdb connect <TV-IP>` again.

### The app opens to a black screen

- Check the TV's model year (below). Models from 2020 or earlier are not supported.
- Otherwise please report it: this build has not been tested on a real TV yet.

### How do I find my TV's model year?

- On the TV: Settings > Support > About This TV. The **model code** is shown there (also on a sticker on the
  back of the TV).
- In most Samsung model codes a letter shows the year: **T** = 2020, **A** = 2021, **B** = 2022, **C** = 2023,
  **D** = 2024. It is usually right after the screen size (for example `UE55`**`A`**`U7100`), or at the end for
  some premium models (for example `QE55QN90`**`A`**).
- 2021 (A) and newer are supported.
